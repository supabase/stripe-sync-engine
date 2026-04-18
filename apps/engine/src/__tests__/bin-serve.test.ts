import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertUseEnvProxy: vi.fn(),
  createConnectorResolver: vi.fn(),
  startApiServer: vi.fn(),
  defaultConnectors: {
    sources: { stripe: { mocked: true } },
    destinations: { postgres: { mocked: true } },
  },
}))

vi.mock('dotenv/config', () => ({}))
vi.mock('@stripe/sync-ts-cli/env-proxy', () => ({
  assertUseEnvProxy: mocks.assertUseEnvProxy,
}))
vi.mock('../lib/index.js', () => ({
  createConnectorResolver: mocks.createConnectorResolver,
}))
vi.mock('../lib/default-connectors.js', () => ({
  defaultConnectors: mocks.defaultConnectors,
}))
vi.mock('../api/server.js', () => ({
  startApiServer: mocks.startApiServer,
}))

describe('bin/serve', () => {
  const originalPort = process.env.PORT

  beforeEach(() => {
    vi.resetModules()
    mocks.assertUseEnvProxy.mockReset()
    mocks.createConnectorResolver.mockReset()
    mocks.startApiServer.mockReset()
  })

  afterEach(() => {
    if (originalPort === undefined) {
      delete process.env.PORT
    } else {
      process.env.PORT = originalPort
    }
  })

  it('uses bundled connectors only and reads the port from env', async () => {
    const resolver = {
      resolveSource: vi.fn(),
      resolveDestination: vi.fn(),
      sources: vi.fn(),
      destinations: vi.fn(),
    }
    process.env.PORT = '4000'
    mocks.createConnectorResolver.mockResolvedValue(resolver)

    const modulePath = '../bin/serve.js'
    await import(modulePath)

    expect(mocks.assertUseEnvProxy).toHaveBeenCalled()
    expect(mocks.createConnectorResolver).toHaveBeenCalledWith(mocks.defaultConnectors, {
      path: false,
      npm: false,
    })
    expect(mocks.startApiServer).toHaveBeenCalledWith({ resolver, port: 4000 })
  })

  it('defaults to port 3000', async () => {
    const resolver = {
      resolveSource: vi.fn(),
      resolveDestination: vi.fn(),
      sources: vi.fn(),
      destinations: vi.fn(),
    }
    delete process.env.PORT
    mocks.createConnectorResolver.mockResolvedValue(resolver)

    const modulePath = '../bin/serve.js'
    await import(modulePath)

    expect(mocks.createConnectorResolver).toHaveBeenCalledWith(mocks.defaultConnectors, {
      path: false,
      npm: false,
    })
    expect(mocks.startApiServer).toHaveBeenCalledWith({ resolver, port: 3000 })
  })
})
