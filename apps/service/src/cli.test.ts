import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from 'citty'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runMock = vi.fn(async () => {})
const createWorkerMock = vi.fn(async () => ({ run: runMock }))
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

vi.mock('@temporalio/client', () => ({
  Connection: { connect: connectMock },
  Client: class {
    workflow = workflowClientMock

    constructor(_: unknown) {}
  },
}))

let tempDataDir: string

beforeEach(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'sync-service-cli-'))
  process.env.DATA_DIR = tempDataDir
  process.env.TEMPORAL_ADDRESS = 'localhost:7233'
  delete process.env.TEMPORAL_TASK_QUEUE
  vi.clearAllMocks()
})

afterEach(() => {
  rmSync(tempDataDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
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
        '{"type":"postgres","postgres":{"connection_string":"postgres://localhost/db","schema":"public"}}',
      ],
    })

    const createOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const created = JSON.parse(createOutput)

    writeSpy.mockClear()
    await runCommand(program, { rawArgs: ['pipelines', 'get', created.id] })
    const getOutput = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')
    const fetched = JSON.parse(getOutput)

    expect(connectMock).toHaveBeenCalledWith({ address: 'localhost:7233' })
    expect(workflowClientMock.start).toHaveBeenCalledOnce()
    expect(created.id).toMatch(/^pipe_/)
    expect(created.source.type).toBe('stripe')
    expect(created.destination.type).toBe('postgres')
    expect(fetched.id).toBe(created.id)
    expect(fetched.source.type).toBe('stripe')

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
        '--postgres.connection-string',
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
      connection_string: 'postgres://localhost/db',
      schema: 'public',
    })

    writeSpy.mockRestore()
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
          '--postgres.connection-string',
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

describe('resolveGeneratedSpecUrl', () => {
  it('uses the colocated generated spec when present', async () => {
    vi.resetModules()
    const { resolveGeneratedSpecUrl } = await import('./cli.js')

    const resolved = resolveGeneratedSpecUrl('file:///repo/apps/service/src/cli.ts', (url) =>
      url.pathname.endsWith('/src/__generated__/openapi.json')
    )

    expect(resolved.pathname).toBe('/repo/apps/service/src/__generated__/openapi.json')
  })

  it('falls back to src/__generated__ for compiled dist CLI', async () => {
    vi.resetModules()
    const { resolveGeneratedSpecUrl } = await import('./cli.js')

    const resolved = resolveGeneratedSpecUrl('file:///repo/apps/service/dist/cli.js', (url) =>
      url.pathname.endsWith('/src/__generated__/openapi.json')
    )

    expect(resolved.pathname).toBe('/repo/apps/service/src/__generated__/openapi.json')
  })
})
