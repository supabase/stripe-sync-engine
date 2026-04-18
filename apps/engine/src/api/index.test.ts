import { beforeEach, describe, expect, it, vi } from 'vitest'

const createConnectorResolver = vi.fn(async () => ({}))
const createApp = vi.fn(async () => ({ fetch: vi.fn() }))
const startApiServer = vi.fn()
const serve = vi.fn()

vi.mock('../lib/index.js', () => ({
  createConnectorResolver,
}))

vi.mock('./app.js', () => ({
  createApp,
}))

vi.mock('./server.js', () => ({
  startApiServer,
}))

vi.mock('@hono/node-server', () => ({
  serve,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

describe('api/index', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Reflect.deleteProperty(globalThis as Record<string, unknown>, 'Bun')
  })

  it('exports the API surface without starting a server', async () => {
    const mod = await import('./index.js')

    expect(typeof mod.createApp).toBe('function')
    expect(typeof mod.startApiServer).toBe('function')
    expect(createConnectorResolver).not.toHaveBeenCalled()
    expect(createApp).not.toHaveBeenCalled()
    expect(startApiServer).not.toHaveBeenCalled()
    expect(serve).not.toHaveBeenCalled()
  })
})
