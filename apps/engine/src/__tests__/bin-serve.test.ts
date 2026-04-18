import { beforeEach, describe, expect, it, vi } from 'vitest'

const bootstrap = vi.fn()
const resolver = {
  resolveSource: vi.fn(),
  resolveDestination: vi.fn(),
  sources: () => new Map(),
  destinations: () => new Map(),
}
const createConnectorResolver = vi.fn(async () => resolver)
const startApiServer = vi.fn()
const defaultConnectors = {
  sources: { stripe: {} },
  destinations: { postgres: {}, google_sheets: {} },
}

vi.mock('../bin/bootstrap.js', () => ({
  bootstrap,
}))

vi.mock('../lib/index.js', () => ({
  createConnectorResolver,
}))

vi.mock('../lib/default-connectors.js', () => ({
  defaultConnectors,
}))

vi.mock('../api/server.js', () => ({
  startApiServer,
}))

describe('serve bin', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.PORT
  })

  it('starts the bundled-only server with dynamic discovery disabled', async () => {
    process.env.PORT = '4010'

    await import('../bin/serve.js')

    expect(bootstrap).toHaveBeenCalledOnce()
    expect(createConnectorResolver).toHaveBeenCalledWith(defaultConnectors, {
      path: false,
      npm: false,
    })
    expect(startApiServer).toHaveBeenCalledWith({
      resolver,
      port: 4010,
    })
  })
})
