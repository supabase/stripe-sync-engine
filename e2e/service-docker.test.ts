import { afterAll, beforeAll, expect, it } from 'vitest'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'
import { execSync } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import pg from 'pg'
import path from 'node:path'
import { describeWithEnv } from './test-helpers.js'
import type { paths } from '../apps/service/src/__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Config — env vars allow CI to override defaults for compose-based local dev
// ---------------------------------------------------------------------------

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:4020'
// URL the service container uses to reach Postgres.
// compose: postgres:5432 (internal DNS) | CI --network=host: localhost:55432
const POSTGRES_CONTAINER_URL =
  process.env.POSTGRES_CONTAINER_URL ?? 'postgresql://postgres:postgres@postgres:5432/postgres'
// URL the test runner (host) uses to query Postgres.
const POSTGRES_HOST_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:55432/postgres'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const COMPOSE_CMD = `docker compose -f compose.yml -f compose.dev.yml`

const SKIP_CLEANUP = process.env.SKIP_CLEANUP === '1'
const STOP_MANAGED_STACK = process.env.STOP_MANAGED_STACK === '1'
// When true, skip building and starting containers (CI pre-starts them).
const SKIP_SETUP = process.env.SKIP_SETUP === '1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 120_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

function api() {
  return createFetchClient<paths>({ baseUrl: SERVICE_URL })
}

/** Returns true if the service health endpoint responds 200. */
async function isServiceHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVICE_URL}/health`)
    return r.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithEnv(
  'service docker e2e: stripe → postgres',
  ['STRIPE_API_KEY', 'SERVICE_DOCKER_E2E'],
  ({ STRIPE_API_KEY }) => {
    let pool: pg.Pool
    let schema: string
    let managedContainers = false

    beforeAll(async () => {
      schema = `docker_e2e_${Date.now()}`

      if (SKIP_SETUP) {
        console.log('\n  SKIP_SETUP=1 — assuming containers are already managed externally')
      } else {
        if (await isServiceHealthy()) {
          console.log('\n  Service already healthy — reconciling shared stack')
        }
        managedContainers = true

        console.log('\n  Building packages...')
        execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'pipe' })

        // 2. Start engine + service + worker containers (infra already running via compose/CI)
        console.log('  Starting containers...')
        execSync(`${COMPOSE_CMD} up --build --no-deps -d engine service worker`, {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        })

        // 3. Wait for service HTTP API to be ready
        console.log('  Waiting for service health...')
        await pollUntil(isServiceHealthy)
      }

      // 4. Open Postgres pool on host-mapped port for verification
      pool = new pg.Pool({ connectionString: POSTGRES_HOST_URL })
      await pool.query('SELECT 1')

      console.log(`  Service:  ${SERVICE_URL}`)
      console.log(`  Schema:   ${schema}`)
      console.log(`  Postgres: ${POSTGRES_HOST_URL}`)
      console.log(`  Cleanup:  ${SKIP_CLEANUP ? 'no (SKIP_CLEANUP=1)' : 'yes'}`)
      console.log(`  Stop stack: ${STOP_MANAGED_STACK ? 'yes' : 'no'}`)
    }, 5 * 60_000) // 5 min — includes docker build

    afterAll(async () => {
      if (!SKIP_CLEANUP) {
        await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      }
      await pool?.end().catch(() => {})

      // Only stop containers we started
      if (managedContainers && STOP_MANAGED_STACK) {
        execSync(`${COMPOSE_CMD} stop engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
        execSync(`${COMPOSE_CMD} rm -f engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
      }
    }, 2 * 60_000) // 2 min — docker stop can be slow

    it('create pipeline → data lands in Postgres → delete', async () => {
      const c = api()

      // --- Create ---
      const stripeMockUrl = process.env.STRIPE_MOCK_URL
      const { data: created, error: createErr } = await c.POST('/pipelines', {
        body: {
          source: {
            type: 'stripe',
            stripe: {
              api_key: STRIPE_API_KEY,
              api_version: BUNDLED_API_VERSION,
              ...(stripeMockUrl
                ? {
                    base_url: stripeMockUrl,
                    account_id: 'acct_mock',
                    account_created: 1_700_000_000,
                  }
                : {}),
            },
          },
          destination: {
            type: 'postgres',
            postgres: {
              url: POSTGRES_CONTAINER_URL,
              schema,
            },
          },
          streams: [{ name: 'product', backfill_limit: 500 }],
        },
      })
      expect(createErr).toBeUndefined()
      expect(created!.id).toMatch(/^pipe_/)
      const id = created!.id
      console.log(`\n  Pipeline: ${id}`)

      // --- Wait for data ---
      await pollUntil(
        async () => {
          try {
            const r = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."product"`)
            return r.rows[0].n > 0
          } catch {
            return false
          }
        },
        { timeout: 200_000 }
      )

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."product"`)
      console.log(`  Synced:   ${rows[0].n} products`)
      expect(rows[0].n).toBeGreaterThan(0)

      // Verify shape
      const { rows: sample } = await pool.query(`SELECT id FROM "${schema}"."product" LIMIT 1`)
      expect(sample[0].id).toMatch(/^prod_/)

      // --- List includes the pipeline ---
      const { data: list } = await c.GET('/pipelines')
      expect(list!.data.some((p: { id: string }) => p.id === id)).toBe(true)

      // --- Get returns status ---
      const { data: got } = await c.GET('/pipelines/{id}', { params: { path: { id } } })
      expect(typeof got!.status).toBe('string')

      // --- Delete ---
      const { data: deleted, error: deleteErr } = await c.DELETE('/pipelines/{id}', {
        params: { path: { id } },
      })
      expect(deleteErr).toBeUndefined()
      expect(deleted).toEqual({ id, deleted: true })

      // --- Verify gone from list and get ---
      const { data: listAfter } = await c.GET('/pipelines')
      expect(listAfter!.data.find((p: { id: string }) => p.id === id)).toBeUndefined()

      const { error: getAfter } = await c.GET('/pipelines/{id}', { params: { path: { id } } })
      expect(getAfter).toBeDefined()
    }, 240_000)

    it('simulate_webhook_sync → events land in Postgres', async () => {
      const c = api()
      const stripeMockUrl = process.env.STRIPE_MOCK_URL

      // With a real Stripe key, create a product so there's a known event to sync.
      // stripe-mock's /v1/events returns canned fixtures and doesn't track
      // dynamically created objects, so we skip the specific-ID check there.
      let createdProductId: string | undefined
      let createdAfter: number | undefined
      if (!stripeMockUrl) {
        createdAfter = Math.floor(Date.now() / 1000) - 5
        const productRes = await fetch('https://api.stripe.com/v1/products', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STRIPE_API_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'name=SimulateWebhookSyncTest',
        })
        expect(productRes.ok).toBe(true)
        const product = (await productRes.json()) as { id: string }
        createdProductId = product.id
        console.log(`\n  Created product: ${product.id}`)
      }

      // Create pipeline
      const { data: created, error: createErr } = await c.POST('/pipelines', {
        body: {
          source: {
            type: 'stripe',
            stripe: {
              api_key: STRIPE_API_KEY,
              api_version: BUNDLED_API_VERSION,
              ...(stripeMockUrl ? { base_url: stripeMockUrl } : {}),
            },
          },
          destination: {
            type: 'postgres',
            postgres: { url: POSTGRES_CONTAINER_URL, schema },
          },
          streams: [{ name: 'product' }],
        },
        params: { query: { skip_check: true } },
      })
      expect(createErr).toBeUndefined()
      const id = created!.id
      console.log(`  Pipeline: ${id}`)

      // Setup destination tables
      const setupRes = await fetch(`${SERVICE_URL}/pipelines/${id}/setup?only=destination`, {
        method: 'POST',
      })
      expect(setupRes.status).toBe(200)
      await setupRes.text()

      // Run simulate_webhook_sync
      const url = createdAfter
        ? `${SERVICE_URL}/pipelines/${id}/simulate_webhook_sync?created_after=${createdAfter}`
        : `${SERVICE_URL}/pipelines/${id}/simulate_webhook_sync`
      const syncRes = await fetch(url, { method: 'POST' })
      expect(syncRes.status).toBe(200)
      const syncBody = await syncRes.text()
      expect(syncBody).toContain('"type":"eof"')

      if (createdProductId) {
        // Real Stripe: assert the specific product row landed in Postgres
        const { rows } = await pool.query(`SELECT id FROM "${schema}"."product" WHERE id = $1`, [
          createdProductId,
        ])
        expect(rows).toHaveLength(1)
        console.log(`  Product ${createdProductId} found in Postgres ✓`)
      } else {
        // stripe-mock: just assert the endpoint ran end-to-end (events piped through engine)
        console.log('  stripe-mock: verified simulate_webhook_sync ran end-to-end ✓')
      }

      // Cleanup
      await c.DELETE('/pipelines/{id}', { params: { path: { id } } })
    }, 120_000)
  }
)
