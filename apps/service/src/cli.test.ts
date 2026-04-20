import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectorResolver } from '@stripe/sync-engine'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import { memoryPipelineStore } from './lib/stores-memory.js'

const runMock = vi.fn(async () => {})
const createWorkerMock = vi.fn(async () => ({ run: runMock }))
const createAppMock = vi.fn()
const workflowClientMock = {
  start: vi.fn(async () => {}),
  getHandle: vi.fn(() => ({
    signal: vi.fn(async () => {}),
    query: vi.fn(async () => ({})),
    terminate: vi.fn(async () => {}),
  })),
  list: vi.fn(async function* () {}),
}
const connectMock = vi.fn(async () => ({}))

vi.mock('./temporal/worker.js', () => ({
  createWorker: createWorkerMock,
}))

vi.mock('./api/app.js', () => ({
  createApp: createAppMock,
}))

vi.mock('@temporalio/client', () => ({
  Connection: { connect: connectMock },
  Client: class {
    workflow = workflowClientMock

    constructor(_: unknown) {}
  },
}))

let tempDataDir: string
let serviceSpec: unknown
let syncRequests: Array<{
  id: string
  query: Record<string, string>
  body: Record<string, unknown>
}> = []

beforeAll(async () => {
  const { createApp: createRealApp } =
    await vi.importActual<typeof import('./api/app.js')>('./api/app.js')
  const resolver = await createConnectorResolver({
    sources: { stripe: sourceStripe },
    destinations: { postgres: destinationPostgres, google_sheets: destinationGoogleSheets },
  })
  const app = createRealApp({
    resolver,
    pipelineStore: memoryPipelineStore(),
  })
  const response = await app.request('/openapi.json')
  serviceSpec = await response.json()
})

function buildMockApp() {
  const pipelines = new Map<string, any>()
  let nextId = 1
  const syncCounts = new Map<string, number>()

  const handleRequest = async (req: Request) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/openapi.json') {
      return new Response(JSON.stringify(serviceSpec), {
        headers: { 'content-type': 'application/json' },
      })
    }

    if (req.method === 'POST' && url.pathname === '/pipelines') {
      const body = await req.json()
      const stripe = body.source?.stripe
      const destination = body.destination

      if (
        stripe?.api_version &&
        stripe.api_version !== '2025-03-31.basil' &&
        stripe.api_version !== '2025-04-30.basil'
      ) {
        return new Response(
          JSON.stringify({
            error: [{ path: ['source', 'stripe', 'api_version'], message: 'Invalid option' }],
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      }

      if (destination?.type === 'google_sheets') {
        if (!destination.google_sheets?.access_token || !destination.google_sheets?.refresh_token) {
          return new Response(JSON.stringify({ error: 'invalid google_sheets config' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
      }

      if (destination?.type === 'postgres') {
        destination.postgres = {
          port: 5432,
          batch_size: 100,
          ...destination.postgres,
        }
      }

      if (destination?.type === 'google_sheets') {
        destination.google_sheets = {
          spreadsheet_title: 'Stripe Sync',
          batch_size: 50,
          ...destination.google_sheets,
        }
      }

      const pipeline = {
        id: `pipe_${nextId++}`,
        ...body,
        desired_status: 'active',
        status: 'setup',
      }
      pipelines.set(pipeline.id, pipeline)
      return new Response(JSON.stringify(pipeline), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (req.method === 'GET' && url.pathname.startsWith('/pipelines/')) {
      const id = url.pathname.split('/').pop()!
      const pipeline = pipelines.get(id)
      if (!pipeline) {
        return new Response(JSON.stringify({ error: `Pipeline ${id} not found` }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(pipeline), {
        headers: { 'content-type': 'application/json' },
      })
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/pipelines/')) {
      const id = url.pathname.split('/').pop()!
      const pipeline = pipelines.get(id)
      if (!pipeline) {
        return new Response(JSON.stringify({ error: `Pipeline ${id} not found` }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      pipelines.delete(id)
      return new Response(JSON.stringify({ id, deleted: true }), {
        headers: { 'content-type': 'application/json' },
      })
    }

    if (req.method === 'POST' && url.pathname.match(/^\/pipelines\/[^/]+\/sync$/)) {
      const id = url.pathname.split('/')[2]!
      const pipeline = pipelines.get(id)
      if (!pipeline) {
        return new Response(JSON.stringify({ error: `Pipeline ${id} not found` }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }

      const body = req.headers.get('content-type')?.includes('application/json')
        ? await req.json()
        : {}
      syncRequests.push({
        id,
        query: Object.fromEntries(url.searchParams.entries()),
        body: body as Record<string, unknown>,
      })

      const count = (syncCounts.get(id) ?? 0) + 1
      syncCounts.set(id, count)

      const runProgress = {
        started_at: new Date().toISOString(),
        elapsed_ms: count * 100,
        global_state_count: count,
        derived: { status: 'succeeded', records_per_second: 10, states_per_second: 1 },
        streams: {},
      }
      const endingState = {
        source: { streams: { customers: { cursor: `cus_${count}` } }, global: {} },
        destination: {},
        sync_run: { progress: runProgress },
      }

      return new Response(
        [
          JSON.stringify({ type: 'progress', progress: runProgress }),
          JSON.stringify({
            type: 'eof',
            eof: {
              has_more: count === 1,
              ending_state: endingState,
              run_progress: runProgress,
              request_progress: runProgress,
            },
          }),
        ].join('\n') + '\n',
        { headers: { 'content-type': 'application/x-ndjson' } }
      )
    }

    return new Response('not found', { status: 404 })
  }

  return {
    request: (input: string) => handleRequest(new Request(`http://localhost${input}`)),
    fetch: handleRequest,
  }
}

beforeEach(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'sync-service-cli-'))
  syncRequests = []
  process.env.DATA_DIR = tempDataDir
  process.env.LOG_LEVEL = 'silent'
  delete process.env.TEMPORAL_ADDRESS
  delete process.env.TEMPORAL_TASK_QUEUE
  vi.clearAllMocks()
  createAppMock.mockImplementation(() => buildMockApp())
})

afterEach(() => {
  rmSync(tempDataDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
  delete process.env.LOG_LEVEL
  delete process.env.TEMPORAL_ADDRESS
  delete process.env.TEMPORAL_TASK_QUEUE
})

describe('generated pipeline CLI', () => {
  it('uses the Pipelines group with create/list/get subcommands', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const program = await createProgram()

    expect(Object.keys(program.subCommands ?? {})).toContain('pipelines')
    expect(Object.keys(program.subCommands?.['pipelines']?.subCommands ?? {})).toEqual(
      expect.arrayContaining(['create', 'list', 'get'])
    )
  })

  it('dispatches pipelines create and get via the generated CLI using a temp DATA_DIR', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--source',
        '{"type":"stripe","stripe":{"api_key":"sk_test_123","api_version":"2025-03-31.basil"}}',
        '--destination',
        '{"type":"postgres","postgres":{"url":"postgres://localhost/db","schema":"public"}}',
      ],
    })

    const createOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(createOutput)

    writeSpy.mockClear()
    await runCommand(program, { rawArgs: ['pipelines', 'get', created.id] })
    const getOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const fetched = JSON.parse(getOutput)

    expect(connectMock).not.toHaveBeenCalled()
    expect(workflowClientMock.start).not.toHaveBeenCalled()
    expect(createAppMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temporal: undefined,
      })
    )
    expect(created.id).toMatch(/^pipe_/)
    expect(created.source.type).toBe('stripe')
    expect(created.destination.type).toBe('postgres')
    expect(fetched.id).toBe(created.id)
    expect(fetched.source.type).toBe('stripe')

    writeSpy.mockRestore()
  })

  it('passes a friendly pipeline id through create via --id', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--id',
        'pipe_shop_docker_pg',
        '--source',
        '{"type":"stripe","stripe":{"api_key":"sk_test_123","api_version":"2025-03-31.basil"}}',
        '--destination',
        '{"type":"postgres","postgres":{"url":"postgres://localhost/db","schema":"public"}}',
      ],
    })

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(output)

    expect(created.id).toBe('pipe_shop_docker_pg')

    writeSpy.mockRestore()
  })

  it('accepts a friendly pipeline id as a positional for get, check, and delete', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--id',
        'pipe_shop_docker_pg',
        '--source',
        '{"type":"stripe","stripe":{"api_key":"sk_test_123","api_version":"2025-03-31.basil"}}',
        '--destination',
        '{"type":"postgres","postgres":{"url":"postgres://localhost/db","schema":"public"}}',
      ],
    })

    writeSpy.mockClear()
    await runCommand(program, { rawArgs: ['pipelines', 'get', 'pipe_shop_docker_pg'] })
    const getOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(JSON.parse(getOutput)).toMatchObject({ id: 'pipe_shop_docker_pg' })

    writeSpy.mockClear()
    await runCommand(program, { rawArgs: ['pipelines', 'check', 'pipe_shop_docker_pg'] })
    const checkOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(JSON.parse(checkOutput)).toMatchObject({ id: 'pipe_shop_docker_pg' })

    writeSpy.mockClear()
    await runCommand(program, { rawArgs: ['pipelines', 'delete', 'pipe_shop_docker_pg'] })
    const deleteOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(JSON.parse(deleteOutput)).toEqual({ id: 'pipe_shop_docker_pg', deleted: true })

    writeSpy.mockRestore()
  })

  it('accepts connector shorthand flags for stripe + postgres', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--stripe.api-key',
        'sk_test_123',
        '--stripe.api-version',
        '2025-03-31.basil',
        '--postgres.url',
        'postgres://localhost/db',
        '--postgres.schema',
        'public',
      ],
    })

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(output)

    expect(created.source).toEqual({
      type: 'stripe',
      stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
    })
    expect(created.destination.type).toBe('postgres')
    expect(created.destination.postgres).toMatchObject({
      url: 'postgres://localhost/db',
      schema: 'public',
    })

    writeSpy.mockRestore()
  })

  it('still accepts deprecated postgres.connection-string shorthand', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--stripe.api-key',
        'sk_test_123',
        '--stripe.api-version',
        '2025-03-31.basil',
        '--postgres.connection-string',
        'postgres://localhost/db',
        '--postgres.schema',
        'public',
      ],
    })

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(output)

    expect(created.destination.postgres).toMatchObject({
      connection_string: 'postgres://localhost/db',
      schema: 'public',
    })

    writeSpy.mockRestore()
  })

  it('sync loops until complete and passes streams + run_id + reset_state overrides', async () => {
    const mockApp = buildMockApp()
    createAppMock.mockImplementation(() => mockApp)
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = await createProgram()

    const pipelineId = 'pipe_shop_prod_pg_docker'
    await mockApp.fetch(
      new Request('http://localhost/pipelines', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: pipelineId,
          source: {
            type: 'stripe',
            stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
          },
          destination: {
            type: 'postgres',
            postgres: { url: 'postgres://localhost/db', schema: 'public' },
          },
        }),
      })
    )

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'sync',
        pipelineId,
        '--streams',
        'customers,prices',
        '--sync-run-id',
        'run_demo',
        '--reset-state',
      ],
    })

    expect(syncRequests).toHaveLength(2)
    expect(syncRequests[0]).toMatchObject({
      id: pipelineId,
      query: { run_id: 'run_demo', reset_state: 'true' },
      body: { streams: [{ name: 'customers' }, { name: 'prices' }] },
    })
    // Second iteration should NOT have reset_state (only first does)
    expect(syncRequests[1]?.query).toMatchObject({
      run_id: 'run_demo',
    })
    expect(syncRequests[1]?.query).not.toHaveProperty('reset_state')
    // Server persists state, so CLI doesn't need to pass sync_state in body
    expect(syncRequests[1]?.body).toMatchObject({
      streams: [{ name: 'customers' }, { name: 'prices' }],
    })
    expect(syncRequests[1]?.body).not.toHaveProperty('sync_state')

    stderrSpy.mockRestore()
  })

  it('sync leaves a final progress summary visible in interactive mode', async () => {
    const renderMock = vi.fn(() => ({
      rerender: vi.fn(),
      unmount: vi.fn(),
      waitUntilExit: vi.fn(async () => undefined),
      waitUntilRenderFlush: vi.fn(async () => undefined),
      cleanup: vi.fn(),
      clear: vi.fn(),
    }))
    vi.doMock('ink', () => ({ render: renderMock }))

    const originalIsTTY = process.stderr.isTTY
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true })

    try {
      const mockApp = buildMockApp()
      createAppMock.mockImplementation(() => mockApp)
      vi.resetModules()
      const { createProgram } = await import('./cli.js')
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const program = await createProgram()

      const pipelineId = 'pipe_shop_prod_pg_docker'
      await mockApp.fetch(
        new Request('http://localhost/pipelines', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: pipelineId,
            source: {
              type: 'stripe',
              stripe: { api_key: 'sk_test_123', api_version: '2025-03-31.basil' },
            },
            destination: {
              type: 'postgres',
              postgres: { url: 'postgres://localhost/db', schema: 'public' },
            },
          }),
        })
      )

      await runCommand(program, {
        rawArgs: ['pipelines', 'sync', pipelineId],
      })

      const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
      expect(stderr).toContain('Log:')
      expect(renderMock).toHaveBeenCalled()

      stderrSpy.mockRestore()
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      })
      vi.doUnmock('ink')
    }
  })

  it('sync exits non-zero and prints the error when the stream returns an error log', async () => {
    const mockApp = buildMockApp()
    createAppMock.mockImplementation(() => ({
      ...mockApp,
      fetch: (req: Request) => {
        const url = new URL(req.url, 'http://localhost')
        if (req.method === 'POST' && url.pathname.match(/^\/pipelines\/[^/]+\/sync$/)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'log',
                log: { level: 'error', message: 'connect ECONNREFUSED 127.0.0.1:4010' },
              }) + '\n',
              { headers: { 'content-type': 'application/x-ndjson' } }
            )
          )
        }
        return mockApp.fetch(req)
      },
    }))

    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await expect(
      runCommand(program, {
        rawArgs: ['pipelines', 'sync', 'pipe_shop_prod_pg_docker', '--plain'],
      })
    ).rejects.toThrow(/process\.exit unexpectedly called with "1"/)

    const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(stderr).toContain('ECONNREFUSED')

    stderrSpy.mockRestore()
  })

  it('accepts connector shorthand flags for google_sheets destination', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--stripe.api-key',
        'sk_test_123',
        '--stripe.api-version',
        '2025-03-31.basil',
        '--google_sheets.access-token',
        'ya29.token',
        '--google_sheets.refresh-token',
        'refresh-token',
      ],
    })

    const output = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(output)

    expect(created.destination.type).toBe('google_sheets')
    expect(created.destination.google_sheets).toMatchObject({
      access_token: 'ya29.token',
      refresh_token: 'refresh-token',
    })

    writeSpy.mockRestore()
  })

  it('still applies schema validation to shorthand-expanded connector configs', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await expect(
      runCommand(program, {
        rawArgs: [
          'pipelines',
          'create',
          '--stripe.api-key',
          'sk_test_123',
          '--stripe.api-version',
          'not-a-real-version',
          '--postgres.url',
          'postgres://localhost/db',
          '--postgres.schema',
          'public',
        ],
      })
    ).rejects.toThrow(/process\.exit unexpectedly called with "1"/)

    const stderr = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(stderr).toContain('api_version')
    expect(stderr).toContain('Invalid option')

    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
  })

  it('connects to temporal only when TEMPORAL_ADDRESS is set', async () => {
    process.env.TEMPORAL_ADDRESS = 'localhost:7233'

    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const program = await createProgram()

    await runCommand(program, {
      rawArgs: [
        'pipelines',
        'create',
        '--source',
        '{"type":"stripe","stripe":{"api_key":"sk_test_123","api_version":"2025-03-31.basil"}}',
        '--destination',
        '{"type":"postgres","postgres":{"url":"postgres://localhost/db","schema":"public"}}',
      ],
    })

    expect(connectMock).toHaveBeenCalledWith({ address: 'localhost:7233' })
    expect(createAppMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temporal: { client: workflowClientMock, taskQueue: 'sync-engine' },
      })
    )

    writeSpy.mockRestore()
  })
})

describe('worker CLI', () => {
  it('threads worker args through to createWorker', async () => {
    vi.resetModules()
    const { createProgram } = await import('./cli.js')
    const program = (await createProgram()) as {
      subCommands: Record<
        string,
        {
          args: Record<string, unknown>
          run: (input: { args: Record<string, string> }) => Promise<void>
        }
      >
    }

    await program.subCommands['worker']!.run({
      args: {
        'temporal-address': 'localhost:7233',
        'temporal-namespace': 'default',
        'temporal-task-queue': 'sync-engine',
        'engine-url': 'http://localhost:4010',
        'data-dir': '/tmp/test-pipelines',
      },
    })

    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineUrl: 'http://localhost:4010',
        taskQueue: 'sync-engine',
      })
    )
    expect(createWorkerMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        kafkaBroker: expect.anything(),
      })
    )
    expect(runMock).toHaveBeenCalledOnce()
  })
})
