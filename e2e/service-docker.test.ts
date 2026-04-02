import { afterAll, beforeAll, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import pg from 'pg'
import path from 'node:path'
import { describeWithEnv } from './test-helpers.js'
import type { paths } from '../apps/service/src/__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVICE_URL = 'http://localhost:4020'
// Containers reach Postgres by compose service name; host uses mapped port.
const POSTGRES_CONTAINER_URL = 'postgresql://postgres:postgres@postgres:5432/postgres'
const POSTGRES_HOST_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:55432/postgres'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const COMPOSE_CMD = `docker compose -f compose.yml -f compose.service.yml`

const SKIP_CLEANUP = process.env.SKIP_CLEANUP === '1'

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithEnv(
  'service docker e2e: stripe → postgres',
  ['STRIPE_API_KEY', 'SERVICE_DOCKER_E2E'],
  ({ STRIPE_API_KEY }) => {
    let pool: pg.Pool
    let schema: string

    beforeAll(async () => {
      schema = `docker_e2e_${Date.now()}`

      // 1. Build TypeScript so Dockerfiles have fresh dist/
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
      await pollUntil(async () => {
        try {
          const r = await fetch(`${SERVICE_URL}/health`)
          return r.ok
        } catch {
          return false
        }
      })

      // 4. Open Postgres pool on host-mapped port for verification
      pool = new pg.Pool({ connectionString: POSTGRES_HOST_URL })
      await pool.query('SELECT 1')

      console.log(`  Service:  ${SERVICE_URL}`)
      console.log(`  Schema:   ${schema}`)
      console.log(`  Postgres: ${POSTGRES_HOST_URL}`)
      console.log(`  Cleanup:  ${SKIP_CLEANUP ? 'no (SKIP_CLEANUP=1)' : 'yes'}`)
    }, 5 * 60_000) // 5 min — includes docker build

    afterAll(async () => {
      if (!SKIP_CLEANUP) {
        await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      }
      await pool?.end().catch(() => {})

      // Stop only app containers — leave infra (postgres, temporal, stripe-mock) running
      execSync(`${COMPOSE_CMD} stop engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
      execSync(`${COMPOSE_CMD} rm -f engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
    }, 2 * 60_000) // 2 min — docker stop can be slow

    it('create pipeline → data lands in Postgres → delete', async () => {
      const c = api()

      // --- Create ---
      const { data: created, error: createErr } = await c.POST('/pipelines', {
        body: {
          source: { type: 'stripe', api_key: STRIPE_API_KEY },
          destination: {
            type: 'postgres',
            connection_string: POSTGRES_CONTAINER_URL,
            schema,
          },
          streams: [{ name: 'products', backfill_limit: 500 }],
        },
      })
      expect(createErr).toBeUndefined()
      expect(created!.id).toMatch(/^pipe_/)
      const id = created!.id
      console.log(`\n  Pipeline: ${id}`)

      // --- Wait for data ---
      await pollUntil(async () => {
        try {
          const r = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."products"`)
          return r.rows[0].n > 0
        } catch {
          return false
        }
      })

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."products"`)
      console.log(`  Synced:   ${rows[0].n} products`)
      expect(rows[0].n).toBeGreaterThan(0)

      // Verify shape
      const { rows: sample } = await pool.query(`SELECT id FROM "${schema}"."products" LIMIT 1`)
      expect(sample[0].id).toMatch(/^prod_/)

      // --- List includes the pipeline ---
      const { data: list } = await c.GET('/pipelines')
      expect(list!.data.some((p: { id: string }) => p.id === id)).toBe(true)

      // --- Get returns status ---
      const { data: got } = await c.GET('/pipelines/{id}', { params: { path: { id } } })
      expect(got!.status?.phase).toBeDefined()

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
    }, 120_000)
  }
)
