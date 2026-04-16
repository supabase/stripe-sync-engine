import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureObjectTable, quoteIdentifier, upsertObjects } from '@stripe/sync-test-utils'
import {
  createEngine,
  type ConnectorResolver,
  type Engine,
  type Message,
  type PipelineConfig,
  type SourceState,
  type SyncOutput,
} from '../apps/engine/src/index.js'
import stripeSource from '../packages/source-stripe/src/index.js'
import postgresDestination from '../packages/destination-postgres/src/index.js'
import {
  RANGE_START,
  SOURCE_SCHEMA,
  startEngineHarness,
  type EngineHarness,
} from './test-server-harness.js'
import { BUNDLED_API_VERSION } from '../packages/openapi/src/versions.js'
import { createStripeListServer } from '../packages/test-utils/src/server/createStripeListServer.js'
import type {
  StripeListServer,
  StripeListServerOptions,
} from '../packages/test-utils/src/server/types.js'

describe('Stripe failure handling via Docker engine', () => {
  const createdSchemas: string[] = []
  const injectedServers: StripeListServer[] = []
  let harness: EngineHarness
  let engine: Engine
  let schemaCounter = 0

  function makeResolver(): ConnectorResolver {
    return {
      resolveSource: async (name) => {
        if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
        return stripeSource
      },
      resolveDestination: async (name) => {
        if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
        return postgresDestination
      },
      sources: () => new Map(),
      destinations: () => new Map(),
    }
  }

  function uniqueSchema(prefix: string): string {
    const name = `${prefix}_${Date.now()}_${schemaCounter++}`
    createdSchemas.push(name)
    return name
  }

  function makeCustomer(id: string, created: number): Record<string, unknown> {
    return { ...harness.customerTemplate, id, created }
  }

  function makeProduct(id: string, created: number): Record<string, unknown> {
    return { ...harness.productTemplate, id, created }
  }

  function generateCustomers(count: number, prefix: string): Record<string, unknown>[] {
    return Array.from({ length: count }, (_, index) =>
      makeCustomer(`${prefix}${index.toString().padStart(3, '0')}`, RANGE_START + index + 1)
    )
  }

  function cloneSourceState(initial?: SourceState): SourceState {
    return {
      streams: { ...initial?.streams },
      global: { ...initial?.global },
    }
  }

  function captureSourceState(
    state: SourceState,
    msg: {
      source_state: {
        state_type?: 'stream' | 'global'
        stream?: string
        data: unknown
      }
    }
  ): void {
    if (msg.source_state.state_type === 'global') {
      state.global = msg.source_state.data as Record<string, unknown>
      return
    }
    if (msg.source_state.stream) {
      state.streams[msg.source_state.stream] = msg.source_state.data as Record<string, unknown>
    }
  }

  async function batchUpsert(table: string, objects: Record<string, unknown>[]) {
    for (let i = 0; i < objects.length; i += 1000) {
      await upsertObjects(harness.sourcePool, SOURCE_SCHEMA, table, objects.slice(i, i + 1000))
    }
  }

  async function replaceTableObjects(table: string, objects: Record<string, unknown>[]) {
    await ensureObjectTable(harness.sourcePool, SOURCE_SCHEMA, table)
    await harness.sourcePool.query(
      `TRUNCATE TABLE ${quoteIdentifier(SOURCE_SCHEMA)}.${quoteIdentifier(table)}`
    )
    if (objects.length > 0) {
      await batchUpsert(table, objects)
    }
  }

  async function seedCustomers(objects: Record<string, unknown>[]) {
    await replaceTableObjects('customers', objects)
  }

  async function seedProducts(objects: Record<string, unknown>[]) {
    await replaceTableObjects('products', objects)
  }

  async function startInjectedServer(
    overrides: Partial<Pick<StripeListServerOptions, 'auth' | 'failures' | 'accountCreated'>>
  ): Promise<StripeListServer> {
    const server = await createStripeListServer({
      postgresUrl: harness.sourceDocker.connectionString,
      host: '0.0.0.0',
      port: 0,
      accountCreated: overrides.accountCreated ?? RANGE_START,
      auth: overrides.auth,
      failures: overrides.failures,
    })
    injectedServers.push(server)
    return server
  }

  function makePipelineConfig(opts: {
    destSchema: string
    baseUrl: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
  }): PipelineConfig {
    return {
      source: {
        type: 'stripe',
        stripe: {
          api_key: 'sk_test_fake',
          api_version: BUNDLED_API_VERSION,
          base_url: opts.baseUrl,
          rate_limit: 1000,
          ...opts.sourceOverrides,
        },
      },
      destination: {
        type: 'postgres',
        postgres: {
          connection_string: harness.destDocker.connectionString,
          schema: opts.destSchema,
          batch_size: 100,
        },
      },
      streams: opts.streams ?? [{ name: 'customers', sync_mode: 'full_refresh' }],
    }
  }

  async function runSync(opts: {
    destSchema: string
    baseUrl: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
    state?: SourceState
  }): Promise<{ messages: SyncOutput[]; state: SourceState }> {
    const pipeline = makePipelineConfig(opts)
    const messages: SyncOutput[] = []
    const state = cloneSourceState(opts.state)

    for await (const setupMsg of engine.pipeline_setup(pipeline)) {
      void setupMsg
    }

    for await (const msg of engine.pipeline_sync(pipeline, { state: opts.state })) {
      messages.push(msg)
      if (msg.type === 'source_state') {
        captureSourceState(state, msg)
      }
    }

    return { messages, state }
  }

  async function runRead(opts: {
    destSchema: string
    baseUrl: string
    streams?: PipelineConfig['streams']
    sourceOverrides?: Record<string, unknown>
    state?: SourceState
  }): Promise<{ messages: Message[]; state: SourceState }> {
    const pipeline = makePipelineConfig(opts)
    const messages: Message[] = []
    const state = cloneSourceState(opts.state)

    for await (const msg of engine.pipeline_read(pipeline, { state: opts.state })) {
      messages.push(msg)
      if (msg.type === 'source_state') {
        captureSourceState(state, msg)
      }
    }

    return { messages, state }
  }

  async function countRows(schema: string, table: string): Promise<number> {
    try {
      const { rows } = await harness.destPool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM "${schema}"."${table}"`
      )
      return rows[0]?.c ?? 0
    } catch (err) {
      if ((err as { code?: string })?.code === '42P01') return 0
      throw err
    }
  }

  function getErrorTrace(messages: Array<Message | SyncOutput>, stream: string) {
    return messages.find(
      (msg): msg is Extract<Message | SyncOutput, { type: 'trace' }> =>
        msg.type === 'trace' &&
        msg.trace.trace_type === 'error' &&
        (msg.trace as { error: { stream?: string } }).error.stream === stream
    )
  }

  beforeAll(async () => {
    harness = await startEngineHarness()
    engine = await createEngine(makeResolver())
  }, 10 * 60_000)

  beforeEach(async () => {
    await Promise.all([seedCustomers([]), seedProducts([])])
  })

  afterEach(async () => {
    while (injectedServers.length > 0) {
      await injectedServers
        .pop()!
        .close()
        .catch(() => {})
    }
  })

  afterAll(async () => {
    for (const schema of createdSchemas) {
      await harness?.destPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    }
    while (injectedServers.length > 0) {
      await injectedServers
        .pop()!
        .close()
        .catch(() => {})
    }
    await harness?.close()
  }, 60_000)

  it('emits Invalid API Key trace before records when account lookup is unauthorized', async () => {
    const destSchema = uniqueSchema('sync_invalid_key')
    await seedCustomers([makeCustomer('cus_auth_001', RANGE_START + 1)])

    const server = await startInjectedServer({
      auth: { expectedBearerToken: 'sk_test_valid' },
    })

    const { messages, state } = await runRead({
      destSchema,
      baseUrl: server.url,
      sourceOverrides: {
        api_key: 'sk_test_bad',
      },
    })

    const errorTrace = getErrorTrace(messages, 'customers')
    expect(errorTrace).toBeDefined()
    expect(errorTrace).toMatchObject({
      type: 'trace',
      trace: {
        trace_type: 'error',
        error: {
          failure_type: 'auth_error',
          stream: 'customers',
          message: expect.stringContaining('Invalid API Key'),
        },
      },
    })
    expect(messages.filter((msg) => msg.type === 'record')).toHaveLength(0)
    expect(state.streams.customers).toBeUndefined()
  }, 120_000)

  it('continues syncing later streams after one stream returns a non-skippable auth error', async () => {
    const destSchema = uniqueSchema('sync_continue_after_error')
    await seedCustomers([makeCustomer('cus_fail_001', RANGE_START + 1)])
    await seedProducts([
      makeProduct('prod_ok_001', RANGE_START + 2),
      makeProduct('prod_ok_002', RANGE_START + 3),
    ])

    const server = await startInjectedServer({
      failures: [
        {
          path: '/v1/customers',
          status: 401,
          stripeError: {
            type: 'invalid_request_error',
            message: 'Invalid API Key provided: sk_test_fake',
          },
        },
      ],
    })

    const { messages, state } = await runSync({
      destSchema,
      baseUrl: server.url,
      streams: [
        { name: 'customers', sync_mode: 'full_refresh' },
        { name: 'products', sync_mode: 'full_refresh' },
      ],
    })

    const customerError = getErrorTrace(messages, 'customers')
    expect(customerError).toBeDefined()
    expect(customerError).toMatchObject({
      type: 'trace',
      trace: {
        trace_type: 'error',
        error: {
          failure_type: 'auth_error',
          stream: 'customers',
          message: expect.stringContaining('Invalid API Key'),
        },
      },
    })
    expect(await countRows(destSchema, 'customers')).toBe(0)
    expect(await countRows(destSchema, 'products')).toBe(2)
    expect(state.streams.products).toMatchObject({ status: 'complete' })
  }, 120_000)

  it('retries a later transient pagination failure and completes the stream', async () => {
    const destSchema = uniqueSchema('sync_partial_failure')
    await seedCustomers(generateCustomers(150, 'cus_partial_'))

    const server = await startInjectedServer({
      failures: [
        {
          path: '/v1/customers',
          status: 500,
          after: 1,
          times: 1,
          stripeError: {
            type: 'api_error',
            message: 'Injected page 2 failure',
          },
        },
      ],
    })

    const { messages, state } = await runSync({
      destSchema,
      baseUrl: server.url,
    })

    expect(getErrorTrace(messages, 'customers')).toBeUndefined()
    expect(await countRows(destSchema, 'customers')).toBe(150)
    expect(state.streams.customers).toMatchObject({ status: 'complete' })
  }, 120_000)
})
