import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createConnectorResolver: vi.fn(),
  createApp: vi.fn(),
  serve: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@stripe/sync-source-stripe', () => ({ default: {} }))
vi.mock('@stripe/sync-destination-postgres', () => ({ default: {} }))
vi.mock('@stripe/sync-destination-google-sheets', () => ({ default: {} }))
vi.mock('../lib/index.js', () => ({
  createConnectorResolver: mocks.createConnectorResolver,
}))
vi.mock('./app.js', () => ({
  createApp: mocks.createApp,
}))
vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))
vi.mock('../logger.js', () => ({
  logger: mocks.logger,
}))

describe('api/index', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.createConnectorResolver.mockReset()
    mocks.createApp.mockReset()
    mocks.serve.mockReset()
    mocks.logger.info.mockReset()
    mocks.logger.warn.mockReset()
    mocks.logger.error.mockReset()
    mocks.logger.debug.mockReset()
    mocks.createConnectorResolver.mockResolvedValue({})
    mocks.createApp.mockResolvedValue({ fetch: vi.fn() })
  })

  it('re-exports createApp without starting a server on import', async () => {
    const mod = await import('./index.js')

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mod.createApp).toBe(mocks.createApp)
    expect(mocks.createConnectorResolver).not.toHaveBeenCalled()
    expect(mocks.serve).not.toHaveBeenCalled()
  })
})
