import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCliFromSpec = vi.fn((opts) => ({ meta: { name: 'api' }, opts }))
const createConnectorResolver = vi.fn()
const createApp = vi.fn()
const startApiServer = vi.fn()
const createSyncCmd = vi.fn(() => ({ meta: { name: 'sync' } }))
const defaultConnectors = {
  sources: { stripe: {} },
  destinations: { postgres: {}, google_sheets: {} },
}
const resolver = {
  resolveSource: vi.fn(),
  resolveDestination: vi.fn(),
  sources: () => new Map(),
  destinations: () => new Map(),
}
const app = {
  request: vi.fn(),
  fetch: vi.fn(),
}

vi.mock('@stripe/sync-ts-cli/openapi', () => ({
  createCliFromSpec,
}))

vi.mock('../lib/index.js', () => ({
  createConnectorResolver,
}))

vi.mock('../api/app.js', () => ({
  createApp,
}))

vi.mock('../api/server.js', () => ({
  startApiServer,
}))

vi.mock('../cli/sync.js', () => ({
  createSyncCmd,
}))

vi.mock('../cli/supabase.js', () => ({
  supabaseCmd: { meta: { name: 'supabase' } },
}))

vi.mock('../lib/default-connectors.js', () => ({
  defaultConnectors,
}))

describe('engine command wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.argv = ['node', 'sync-engine']

    createConnectorResolver.mockResolvedValue(resolver)
    createApp.mockResolvedValue(app)
    app.request.mockResolvedValue(
      new Response(
        JSON.stringify({
          paths: {
            '/health': { get: { tags: ['Status'] } },
            '/pipeline_check': { post: { tags: ['Stateless Sync API'] } },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
    app.fetch.mockResolvedValue(new Response('ok'))
  })

  it('builds the api command from the in-process app openapi spec', async () => {
    const { createProgram } = await import('../cli/command.js')
    const program = await createProgram()

    expect(createConnectorResolver).toHaveBeenCalledWith(defaultConnectors, {
      path: true,
      npm: false,
      commandMap: {},
    })
    expect(createApp).toHaveBeenCalledWith(resolver)
    expect(createCliFromSpec).toHaveBeenCalledOnce()

    const opts = createCliFromSpec.mock.calls[0][0]
    expect(opts.meta.description).toContain('in-process')
    await opts.handler(new Request('http://localhost/pipeline_check'))
    expect(app.fetch).toHaveBeenCalledOnce()

    expect(program.subCommands?.api).toBeDefined()
    expect(createSyncCmd).toHaveBeenCalledOnce()
    expect(startApiServer).not.toHaveBeenCalled()
  })
})
