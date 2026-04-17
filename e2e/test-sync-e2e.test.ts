import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUNDLED_API_VERSION } from '../packages/openapi/src/versions.js'
import {
  SERVICE_URL,
  pollUntil,
  startServiceHarness,
  type ServiceHarness,
} from './test-server-harness.js'

describe('test-server sync via Docker service: 10k customers', () => {
  let harness: ServiceHarness

  beforeAll(async () => {
    harness = await startServiceHarness()
    expect(harness.expectedIds.length).toBeGreaterThan(0)
  }, 10 * 60_000)

  afterAll(async () => {
    await harness?.close()
  }, 60_000)

  it(
    'POST /pipelines syncs 10k customers from test server to Postgres',
    async () => {
      const destSchema = `e2e_server_sync_${Date.now()}`

      const createRes = await fetch(`${SERVICE_URL}/pipelines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: {
            type: 'stripe',
            stripe: {
              api_key: 'sk_test_fake',
              api_version: BUNDLED_API_VERSION,
              base_url: harness.testServerContainerUrl(),
              rate_limit: 1000,
            },
          },
          destination: {
            type: 'postgres',
            postgres: {
              connection_string: harness.destPgContainerUrl(),
              schema: destSchema,
            },
          },
          streams: [{ name: 'customers' }],
        }),
      })
      expect(createRes.status).toBe(201)

      const created = (await createRes.json()) as { id: string }
      const id = created.id
      expect(id).toMatch(/^pipe_/)

      await pollUntil(async () => {
        try {
          const r = await harness.destPool.query(
            `SELECT count(*)::int AS n FROM "${destSchema}"."customers"`
          )
          return r.rows[0].n === harness.expectedIds.length
        } catch {
          return false
        }
      })

      const { rows } = await harness.destPool.query(
        `SELECT id FROM "${destSchema}"."customers" ORDER BY id`
      )
      const destIds = new Set(rows.map((r: { id: string }) => r.id))
      expect(destIds.size).toBe(harness.expectedIds.length)
      for (const expectedId of harness.expectedIds) {
        expect(destIds.has(expectedId), `missing ${expectedId}`).toBe(true)
      }

      const delRes = await fetch(`${SERVICE_URL}/pipelines/${id}`, { method: 'DELETE' })
      expect(delRes.status).toBe(200)

      await harness.destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
    },
    15 * 60_000
  )
})
