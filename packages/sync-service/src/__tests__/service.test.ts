import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnectorResolver, testSource } from '@stripe/sync-protocol'
import type { StateMessage } from '@stripe/sync-protocol'
import destPostgres from '@stripe/destination-postgres2'
import { SyncService, resolve } from '../service'
import {
  memoryCredentialStore,
  memoryConfigStore,
  memoryStateStore,
  memoryLogSink,
} from '../stores/memory'
import type { Credential, SyncConfig } from '../stores'

// ---------------------------------------------------------------------------
// Docker Postgres lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let pool: pg.Pool
let connectionString: string

beforeAll(async () => {
  containerId = execSync(
    'docker run -d --rm -p 0:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test postgres:16-alpine',
    { encoding: 'utf8' }
  ).trim()

  const hostPort = execSync(`docker port ${containerId} 5432`, {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .pop()

  connectionString = `postgresql://postgres:test@localhost:${hostPort}/test`
  pool = new pg.Pool({ connectionString })

  for (let i = 0; i < 30; i++) {
    try {
      await pool.query('SELECT 1')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('Postgres did not become ready in time')
}, 60_000)

afterAll(async () => {
  await pool?.end()
  if (containerId) {
    execSync(`docker rm -f ${containerId}`)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA = 'test_service'

function makeCred(id: string, type: string, fields: Record<string, unknown> = {}): Credential {
  return {
    id,
    type,
    fields,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }
}

const RECORDS = [
  { id: 'cus_1', name: 'Alice' },
  { id: 'cus_2', name: 'Bob' },
  { id: 'cus_3', name: 'Charlie' },
]

const connectors = createConnectorResolver({
  sources: { stdin: testSource },
  destinations: { postgres2: destPostgres },
})

async function drain(iter: AsyncIterable<StateMessage>): Promise<StateMessage[]> {
  const msgs: StateMessage[] = []
  for await (const msg of iter) msgs.push(msg)
  return msgs
}

/** Build a SyncService with memory stores for a given test scenario. */
function makeService(
  opts: {
    srcCredFields?: Record<string, unknown>
    records?: Record<string, unknown>[]
    refreshCredential?: (id: string) => Promise<void>
  } = {}
) {
  const records = opts.records ?? RECORDS
  const credentials = memoryCredentialStore({
    'src-cred': makeCred('src-cred', 'stdin', opts.srcCredFields ?? {}),
    'dst-cred': makeCred('dst-cred', 'postgres', { connection_string: connectionString }),
  })
  const configs = memoryConfigStore({
    'test-sync': {
      id: 'test-sync',
      source_credential_id: 'src-cred',
      destination_credential_id: 'dst-cred',
      source: {
        type: 'stdin',
        streams: { customers: { records } },
      },
      destination: { type: 'postgres2', schema: SCHEMA },
    },
  })
  const states = memoryStateStore()
  const logs = memoryLogSink()
  const service = new SyncService({
    credentials,
    configs,
    states,
    logs,
    connectors,
    refreshCredential: opts.refreshCredential,
  })
  return { service, credentials, configs, states, logs }
}

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe('resolve()', () => {
  it('merges config + credentials into SyncParams', () => {
    const config: SyncConfig = {
      id: 'sync-1',
      source_credential_id: 'src',
      destination_credential_id: 'dst',
      source: { type: 'stdin', extra: 'a' },
      destination: { type: 'postgres2', schema: 'myschema' },
      streams: [{ name: 'customers' }],
    }

    const params = resolve({
      config,
      sourceCred: makeCred('src', 'stdin', { override: 'b' }),
      destCred: makeCred('dst', 'postgres', { connection_string: 'pg://...' }),
      state: { customers: { cursor: 'abc' } },
    })

    expect(params.source).toBe('stdin')
    expect(params.destination).toBe('postgres2')
    expect(params.source_config).toEqual({ extra: 'a', override: 'b' })
    expect(params.destination_config).toEqual({
      schema: 'myschema',
      connection_string: 'pg://...',
    })
    expect(params.streams).toEqual([{ name: 'customers' }])
    expect(params.state).toEqual({ customers: { cursor: 'abc' } })
  })

  it('credential fields override config fields', () => {
    const config: SyncConfig = {
      id: 's',
      source_credential_id: 'src',
      destination_credential_id: 'dst',
      source: { type: 'stdin', api_key: 'config_val' },
      destination: { type: 'postgres2' },
    }

    const params = resolve({
      config,
      sourceCred: makeCred('src', 'stdin', { api_key: 'cred_val' }),
      destCred: makeCred('dst', 'postgres'),
    })

    expect(params.source_config.api_key).toBe('cred_val')
  })
})

// ---------------------------------------------------------------------------
// SyncService integration (Docker Postgres)
// ---------------------------------------------------------------------------

describe('SyncService integration', () => {
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`)
  })

  it('happy path: records land in Postgres', async () => {
    const { service } = makeService()
    await drain(service.run('test-sync'))

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
    expect(rows[0].n).toBe(3)
  })

  it('state persistence after sync', async () => {
    const { service, states } = makeService()
    await drain(service.run('test-sync'))

    const state = await states.get('test-sync')
    expect(state).toBeDefined()
    expect(state!.customers).toEqual({ status: 'complete' })
  })

  it('log sink receives entries', async () => {
    const { service, logs } = makeService()
    await drain(service.run('test-sync'))

    expect(logs.entries.length).toBeGreaterThan(0)
    expect(logs.entries.some((e) => e.message.includes('checkpoint'))).toBe(true)
  })

  it('resume from state', async () => {
    // Shared stores across both runs
    const credentials = memoryCredentialStore({
      'src-cred': makeCred('src-cred', 'stdin'),
      'dst-cred': makeCred('dst-cred', 'postgres', { connection_string: connectionString }),
    })
    const configs = memoryConfigStore({
      'test-sync': {
        id: 'test-sync',
        source_credential_id: 'src-cred',
        destination_credential_id: 'dst-cred',
        source: {
          type: 'stdin',
          streams: { customers: { records: RECORDS } },
        },
        destination: { type: 'postgres2', schema: SCHEMA },
      },
    })
    const states = memoryStateStore()
    const logs = memoryLogSink()

    // Run 1
    const service1 = new SyncService({ credentials, configs, states, logs, connectors })
    await drain(service1.run('test-sync'))

    const stateAfterRun1 = await states.get('test-sync')
    expect(stateAfterRun1).toBeDefined()

    // Run 2 — same stores, state carries over
    const service2 = new SyncService({ credentials, configs, states, logs, connectors })
    await drain(service2.run('test-sync'))

    // Records still correct (upserted, not duplicated)
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
    expect(rows[0].n).toBe(3)
  })

  it('auth_error triggers refresh + retry', async () => {
    let refreshCount = 0
    const { service, credentials } = makeService({
      srcCredFields: { auth_error_after: 1 },
      refreshCredential: async (credId) => {
        refreshCount++
        // Fix the credential by removing auth_error_after
        const c = await credentials.get(credId)
        await credentials.set(credId, { ...c, fields: {} })
      },
    })

    await drain(service.run('test-sync'))

    expect(refreshCount).toBe(1)

    // After retry, all records should land
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
    expect(rows[0].n).toBe(3)
  })

  it('auth_error without refreshCredential throws', async () => {
    const { service } = makeService({
      srcCredFields: { auth_error_after: 1 },
    })

    await expect(drain(service.run('test-sync'))).rejects.toThrow(
      'auth_error on sync test-sync but no refreshCredential handler configured'
    )
  })

  it('auth_error exhausts retries', async () => {
    let refreshCount = 0
    const { service } = makeService({
      srcCredFields: { auth_error_after: 1 },
      refreshCredential: async () => {
        refreshCount++
        // Don't fix the credential — auth_error will recur
      },
    })

    await expect(drain(service.run('test-sync'))).rejects.toThrow(
      'Auth failed after 2 refresh attempts'
    )
    // 3 refresh calls: initial attempt + 2 retries (loop runs while retries <= MAX_AUTH_RETRIES)
    expect(refreshCount).toBe(3)
  })
})
