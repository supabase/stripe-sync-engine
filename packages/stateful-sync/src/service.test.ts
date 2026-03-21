import { execSync } from 'child_process'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { testSource, testDestination, createConnectorResolver } from '@stripe/stateless-sync'
import type { Message, StateMessage } from '@stripe/stateless-sync'
import destPostgres from '@stripe/destination-postgres'
import { StatefulSync, resolve } from './service'
import {
  memoryCredentialStore,
  memoryConfigStore,
  memoryStateStore,
  memoryLogSink,
} from './stores/memory'
import type { Credential, SyncConfig } from './stores'

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

function makeCred(id: string, type: string, extraFields: Record<string, unknown> = {}): Credential {
  return {
    id,
    type,
    ...extraFields,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }
}

/** Re-iterable async iterable from an array — each `for await` gets a fresh iterator. */
function toAsync<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false as const }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

const MESSAGES = toAsync([
  {
    type: 'record' as const,
    stream: 'customers',
    data: { id: 'cus_1', name: 'Alice' },
    emitted_at: 1000,
  },
  {
    type: 'record' as const,
    stream: 'customers',
    data: { id: 'cus_2', name: 'Bob' },
    emitted_at: 1000,
  },
  {
    type: 'record' as const,
    stream: 'customers',
    data: { id: 'cus_3', name: 'Charlie' },
    emitted_at: 1000,
  },
  { type: 'state' as const, stream: 'customers', data: { status: 'complete' } },
])

const connectors = createConnectorResolver({
  sources: { stdin: testSource },
  destinations: { postgres: destPostgres },
})

async function drain(iter: AsyncIterable<StateMessage>): Promise<StateMessage[]> {
  const msgs: StateMessage[] = []
  for await (const msg of iter) msgs.push(msg)
  return msgs
}

/** Build a StatefulSync with memory stores for a given test scenario. */
function makeService(
  opts: {
    srcCredFields?: Record<string, unknown>
    refreshCredential?: (id: string) => Promise<void>
  } = {}
) {
  const credentials = memoryCredentialStore({
    'src-cred': makeCred('src-cred', 'stdin', opts.srcCredFields ?? {}),
    'dst-cred': makeCred('dst-cred', 'postgres', { connection_string: connectionString }),
  })
  const configs = memoryConfigStore({
    'test-sync': {
      id: 'test-sync',
      source: {
        type: 'stdin',
        credential_id: 'src-cred',
        streams: { customers: {} },
      },
      destination: { type: 'postgres', credential_id: 'dst-cred', schema: SCHEMA },
    },
  })
  const states = memoryStateStore()
  const logs = memoryLogSink()
  const service = new StatefulSync({
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
      source: { type: 'stdin', credential_id: 'src', extra: 'a' },
      destination: { type: 'postgres', credential_id: 'dst', schema: 'myschema' },
      streams: [{ name: 'customers' }],
    }

    const params = resolve({
      config,
      sourceCred: makeCred('src', 'stdin', { override: 'b' }),
      destCred: makeCred('dst', 'postgres', { connection_string: 'pg://...' }),
      state: { customers: { cursor: 'abc' } },
    })

    expect(params.source_name).toBe('stdin')
    expect(params.destination_name).toBe('postgres')
    expect(params.source_config).toEqual({ extra: 'a', override: 'b' })
    expect(params.destination_config).toEqual({
      schema: 'myschema',
      connection_string: 'pg://...',
    })
    expect(params.streams).toEqual([{ name: 'customers' }])
    expect(params.state).toEqual({ customers: { cursor: 'abc' } })
  })

  it('works without credentials (e.g. event-bridge source)', () => {
    const config: SyncConfig = {
      id: 'sync-eb',
      source: { type: 'stripe-event-bridge', livemode: true, account_id: 'acct_123' },
      destination: { type: 'postgres', credential_id: 'dst', schema: 'myschema' },
    }

    const params = resolve({
      config,
      destCred: makeCred('dst', 'postgres', { connection_string: 'pg://...' }),
    })

    expect(params.source_name).toBe('stripe-event-bridge')
    expect(params.source_config).toEqual({ livemode: true, account_id: 'acct_123' })
    expect(params.destination_config).toEqual({
      schema: 'myschema',
      connection_string: 'pg://...',
    })
  })

  it('works without any credentials', () => {
    const config: SyncConfig = {
      id: 'sync-nocred',
      source: { type: 'stdin' },
      destination: { type: 'test' },
    }

    const params = resolve({ config })

    expect(params.source_name).toBe('stdin')
    expect(params.destination_name).toBe('test')
    expect(params.source_config).toEqual({})
    expect(params.destination_config).toEqual({})
  })

  it('credential fields override config fields', () => {
    const config: SyncConfig = {
      id: 's',
      source: { type: 'stdin', credential_id: 'src', api_key: 'config_val' },
      destination: { type: 'postgres', credential_id: 'dst' },
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
// StatefulSync integration (Docker Postgres)
// ---------------------------------------------------------------------------

describe('StatefulSync integration', () => {
  beforeEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`)
  })

  it('happy path: records land in Postgres', async () => {
    const { service } = makeService()
    await drain(service.run('test-sync', MESSAGES))

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
    expect(rows[0].n).toBe(3)
  })

  it('state persistence after sync', async () => {
    const { service, states } = makeService()
    await drain(service.run('test-sync', MESSAGES))

    const state = await states.get('test-sync')
    expect(state).toBeDefined()
    expect(state!.customers).toEqual({ status: 'complete' })
  })

  it('log sink receives entries', async () => {
    const { service, logs } = makeService()
    await drain(service.run('test-sync', MESSAGES))

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
        source: {
          type: 'stdin',
          credential_id: 'src-cred',
          streams: { customers: {} },
        },
        destination: { type: 'postgres', credential_id: 'dst-cred', schema: SCHEMA },
      },
    })
    const states = memoryStateStore()
    const logs = memoryLogSink()

    // Run 1
    const service1 = new StatefulSync({ credentials, configs, states, logs, connectors })
    await drain(service1.run('test-sync', MESSAGES))

    const stateAfterRun1 = await states.get('test-sync')
    expect(stateAfterRun1).toBeDefined()

    // Run 2 — same stores, state carries over (MESSAGES is re-iterable)
    const service2 = new StatefulSync({ credentials, configs, states, logs, connectors })
    await drain(service2.run('test-sync', MESSAGES))

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
        const fixed = Object.fromEntries(
          Object.entries(c as Record<string, unknown>).filter(([k]) => k !== 'auth_error_after')
        )
        await credentials.set(credId, fixed as Credential)
      },
    })

    await drain(service.run('test-sync', MESSAGES))

    expect(refreshCount).toBe(1)

    // After retry, all records should land
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".customers`)
    expect(rows[0].n).toBe(3)
  })

  it('auth_error without refreshCredential throws', async () => {
    const { service } = makeService({
      srcCredFields: { auth_error_after: 1 },
    })

    await expect(drain(service.run('test-sync', MESSAGES))).rejects.toThrow(
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

    await expect(drain(service.run('test-sync', MESSAGES))).rejects.toThrow(
      'Auth failed after 2 refresh attempts'
    )
    // 3 refresh calls: initial attempt + 2 retries (loop runs while retries <= MAX_AUTH_RETRIES)
    expect(refreshCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// StatefulSync new methods (unit — no Docker needed)
// ---------------------------------------------------------------------------

const testConnectors = createConnectorResolver({
  sources: { test: testSource },
  destinations: { test: testDestination },
})

function makeTestService() {
  const credentials = memoryCredentialStore({
    'src-cred': makeCred('src-cred', 'test'),
    'dst-cred': makeCred('dst-cred', 'test'),
  })
  const configs = memoryConfigStore({
    'test-sync': {
      id: 'test-sync',
      source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
      destination: { type: 'test', credential_id: 'dst-cred' },
    },
  })
  const service = new StatefulSync({
    credentials,
    configs,
    states: memoryStateStore(),
    logs: memoryLogSink(),
    connectors: testConnectors,
  })
  return service
}

describe('StatefulSync with credential-less source', () => {
  it('resolves and runs without source credential', async () => {
    const credentials = memoryCredentialStore({
      'dst-cred': makeCred('dst-cred', 'test'),
    })
    const configs = memoryConfigStore({
      'no-src-cred': {
        id: 'no-src-cred',
        source: { type: 'test', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })
    const service = new StatefulSync({
      credentials,
      configs,
      states: memoryStateStore(),
      logs: memoryLogSink(),
      connectors: testConnectors,
    })

    await expect(service.setup('no-src-cred')).resolves.toBeUndefined()
    await expect(service.check('no-src-cred')).resolves.toHaveProperty('source')
  })
})

describe('StatefulSync.setup/teardown/check', () => {
  it('setup() resolves without error', async () => {
    const service = makeTestService()
    await expect(service.setup('test-sync')).resolves.toBeUndefined()
  })

  it('teardown() resolves without error', async () => {
    const service = makeTestService()
    await expect(service.teardown('test-sync')).resolves.toBeUndefined()
  })

  it('check() returns source and destination CheckResult', async () => {
    const service = makeTestService()
    const result = await service.check('test-sync')
    expect(result).toHaveProperty('source')
    expect(result).toHaveProperty('destination')
    expect(result.source.status).toBe('succeeded')
    expect(result.destination.status).toBe('succeeded')
  })
})

describe('StatefulSync.read/write', () => {
  it('read() yields messages from source', async () => {
    const service = makeTestService()
    const input = toAsync([
      { type: 'record' as const, stream: 'customers', data: { id: 'c1' }, emitted_at: 0 },
      { type: 'state' as const, stream: 'customers', data: { cursor: 'abc' } },
    ])
    const msgs: Message[] = []
    for await (const msg of service.read('test-sync', input)) {
      msgs.push(msg)
    }
    expect(msgs.length).toBeGreaterThan(0)
  })

  it('write() persists state and yields StateMessages', async () => {
    const service = makeTestService()
    const messages = toAsync([
      { type: 'record' as const, stream: 'customers', data: { id: 'c1' }, emitted_at: 0 },
      { type: 'state' as const, stream: 'customers', data: { cursor: 'xyz' } },
    ] as Message[])
    const stateMsgs = await drain(service.write('test-sync', messages))
    expect(stateMsgs).toHaveLength(1)
    expect(stateMsgs[0]!.stream).toBe('customers')
    expect(stateMsgs[0]!.data).toEqual({ cursor: 'xyz' })
  })
})

// ---------------------------------------------------------------------------
// push_event — webhook fan-out (unit — no Docker needed)
//
// testSource passes $stdin items straight through as Messages. testDestination
// re-emits StateMessages. So pushing a valid StateMessage via push_event causes
// the matching run() generator to yield it back — observable without I/O.
// ---------------------------------------------------------------------------

/** Yield to the macro-task queue so all pending microtasks/awaits can settle. */
function nextTick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('push_event', () => {
  it('is a no-op when no syncs are running for that credential', () => {
    const service = makeTestService()
    // Should not throw even though nothing is registered
    service.push_event('src-cred', { body: 'test', signature: 'sig' })
  })

  it('delivers an event to a running sync registered under that credential', async () => {
    const service = makeTestService()
    const iter = service.run('test-sync')[Symbol.asyncIterator]()

    // Advance the generator — it creates the internal queue under 'src-cred',
    // then blocks inside testSource.read() waiting for the first $stdin item.
    const firstResult = iter.next()
    await nextTick()

    // Push a StateMessage for stream 'customers' (must be in the catalog).
    // testSource passes it through → engine routes to destination → destination
    // re-emits it as a StateMessage → run() yields it.
    const stateMsg = { type: 'state' as const, stream: 'customers', data: { cursor: 42 } }
    service.push_event('src-cred', stateMsg)

    const result = await firstResult
    expect(result.done).toBe(false)
    expect(result.value).toMatchObject(stateMsg)

    // Abandon the infinite generator
    await iter.return?.(undefined)
  })

  it('fans out to multiple running syncs sharing a credential', async () => {
    const credentials = memoryCredentialStore({
      'src-cred': makeCred('src-cred', 'test'),
      'dst-cred': makeCred('dst-cred', 'test'),
    })
    const configs = memoryConfigStore({
      'sync-a': {
        id: 'sync-a',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
      'sync-b': {
        id: 'sync-b',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })
    const service = new StatefulSync({
      credentials,
      configs,
      states: memoryStateStore(),
      logs: memoryLogSink(),
      connectors: testConnectors,
    })

    const iterA = service.run('sync-a')[Symbol.asyncIterator]()
    const iterB = service.run('sync-b')[Symbol.asyncIterator]()
    const promA = iterA.next()
    const promB = iterB.next()
    await nextTick()

    const stateMsg = { type: 'state' as const, stream: 'customers', data: { cursor: 1 } }
    service.push_event('src-cred', stateMsg)

    const [a, b] = await Promise.all([promA, promB])
    expect(a.done).toBe(false)
    expect(a.value).toMatchObject(stateMsg)
    expect(b.done).toBe(false)
    expect(b.value).toMatchObject(stateMsg)

    await Promise.all([iterA.return?.(undefined), iterB.return?.(undefined)])
  })
})

// ---------------------------------------------------------------------------
// teardown — remove_shared_resources logic
// ---------------------------------------------------------------------------

describe('teardown remove_shared_resources', () => {
  function makeServiceWithTeardownSpy(syncs: Record<string, any>) {
    const teardownSpy = vi.fn()
    const sourceWithTeardown = {
      ...testSource,
      async teardown({
        remove_shared_resources,
      }: {
        config: any
        remove_shared_resources?: boolean
      }) {
        teardownSpy(remove_shared_resources)
      },
    }
    const credentials = memoryCredentialStore({
      'src-cred': makeCred('src-cred', 'test'),
      'dst-cred': makeCred('dst-cred', 'test'),
    })
    const configs = memoryConfigStore(syncs)
    const service = new StatefulSync({
      credentials,
      configs,
      states: memoryStateStore(),
      logs: memoryLogSink(),
      connectors: {
        resolveSource: async () => sourceWithTeardown as any,
        resolveDestination: async () => testDestination as any,
        sources: () => new Map(),
        destinations: () => new Map(),
      },
    })
    return { service, teardownSpy }
  }

  it('passes remove_shared_resources: true when this is the only sync for the credential', async () => {
    const { service, teardownSpy } = makeServiceWithTeardownSpy({
      'sync-1': {
        id: 'sync-1',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })
    await service.teardown('sync-1')
    expect(teardownSpy).toHaveBeenCalledWith(true)
  })

  it('passes remove_shared_resources: false when sibling syncs share the credential', async () => {
    const { service, teardownSpy } = makeServiceWithTeardownSpy({
      'sync-a': {
        id: 'sync-a',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
      'sync-b': {
        id: 'sync-b',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })
    await service.teardown('sync-a')
    expect(teardownSpy).toHaveBeenCalledWith(false)
  })

  it('passes remove_shared_resources: true when sibling uses a different credential', async () => {
    const { service, teardownSpy } = makeServiceWithTeardownSpy({
      'sync-a': {
        id: 'sync-a',
        source: { type: 'test', credential_id: 'src-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
      'sync-b': {
        id: 'sync-b',
        source: { type: 'test', credential_id: 'other-cred', streams: { customers: {} } },
        destination: { type: 'test', credential_id: 'dst-cred' },
      },
    })
    await service.teardown('sync-a')
    expect(teardownSpy).toHaveBeenCalledWith(true)
  })
})
