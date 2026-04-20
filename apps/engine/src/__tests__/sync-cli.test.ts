import { beforeEach, describe, expect, it, vi } from 'vitest'

const createEngine = vi.fn()
const createRemoteEngine = vi.fn()
const readonlyStateStore = vi.fn()
const fileStateStore = vi.fn()
const render = vi.fn(() => ({
  rerender: vi.fn(),
  unmount: vi.fn(),
}))

vi.mock('../lib/index.js', () => ({
  createEngine,
  createRemoteEngine,
}))

vi.mock('../lib/state-store.js', () => ({
  readonlyStateStore,
  fileStateStore,
}))

vi.mock('../cli/source-config-cache.js', () => ({
  applyControlToPipeline: vi.fn((pipeline) => pipeline),
}))

vi.mock('../lib/progress/format.js', () => ({
  ProgressView: () => null,
  formatProgress: vi.fn(() => 'progress'),
}))

vi.mock('ink', () => ({
  render,
}))

describe('sync cli', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    readonlyStateStore.mockReturnValue({
      get: vi.fn(async () => undefined),
      set: vi.fn(),
      setGlobal: vi.fn(),
    })
    fileStateStore.mockReturnValue({
      get: vi.fn(async () => undefined),
      set: vi.fn(),
      setGlobal: vi.fn(),
    })

    const localEngine = {
      pipeline_setup: async function* () {},
      pipeline_sync: async function* () {
        yield {
          type: 'eof',
          eof: {
            run_progress: {
              started_at: new Date().toISOString(),
              elapsed_ms: 1,
              global_state_count: 0,
              derived: { status: 'completed' },
              streams: {},
            },
          },
        }
      },
    }
    createEngine.mockResolvedValue(localEngine)
    createRemoteEngine.mockReturnValue(localEngine)
  })

  it('runs against an in-process engine by default', async () => {
    const { createSyncCmd } = await import('../cli/sync.js')
    const resolver = { resolveSource: vi.fn(), resolveDestination: vi.fn() }
    const command = createSyncCmd(Promise.resolve(resolver as never))

    await command.run?.({
      args: {
        stripeApiKey: 'sk_test_123',
        postgresUrl: 'postgresql://localhost/test',
        postgresSchema: 'public',
        noState: true,
        plain: true,
      } as never,
    })

    expect(createEngine).toHaveBeenCalledWith(resolver)
    expect(createRemoteEngine).not.toHaveBeenCalled()
  })

  it('uses a remote engine only when engineUrl is provided', async () => {
    const { createSyncCmd } = await import('../cli/sync.js')
    const resolver = { resolveSource: vi.fn(), resolveDestination: vi.fn() }
    const command = createSyncCmd(Promise.resolve(resolver as never))

    await command.run?.({
      args: {
        stripeApiKey: 'sk_test_123',
        postgresUrl: 'postgresql://localhost/test',
        postgresSchema: 'public',
        noState: true,
        plain: true,
        engineUrl: 'http://localhost:4010',
      } as never,
    })

    expect(createRemoteEngine).toHaveBeenCalledWith('http://localhost:4010')
    expect(createEngine).not.toHaveBeenCalled()
  })
})
