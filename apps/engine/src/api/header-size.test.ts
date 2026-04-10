import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { ConnectorResolver } from '../lib/index.js'
import { sourceTest, destinationTest, collectFirst } from '../lib/index.js'
import { createApp } from './app.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const KB = 1024
const MB = 1024 * KB

async function getRawConfigJsonSchema(
  connector: typeof sourceTest | typeof destinationTest
): Promise<Record<string, unknown>> {
  const specMsg = await collectFirst(
    connector.spec() as AsyncIterable<import('@stripe/sync-protocol').Message>,
    'spec'
  )
  return specMsg.spec.config
}

let resolver: ConnectorResolver
beforeAll(async () => {
  const [srcConfigSchema, destConfigSchema] = await Promise.all([
    getRawConfigJsonSchema(sourceTest),
    getRawConfigJsonSchema(destinationTest),
  ])
  resolver = {
    resolveSource: async () => sourceTest,
    resolveDestination: async () => destinationTest,
    sources: () =>
      new Map([
        [
          'test',
          {
            connector: sourceTest,
            configSchema: {} as any,
            rawConfigJsonSchema: srcConfigSchema,
          },
        ],
      ]),
    destinations: () =>
      new Map([
        [
          'test',
          {
            connector: destinationTest,
            configSchema: {} as any,
            rawConfigJsonSchema: destConfigSchema,
          },
        ],
      ]),
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipelineHeader(sizeBytes: number): string {
  const base = {
    source: { type: 'test', test: { streams: { customers: {} } } },
    destination: { type: 'test', test: {} },
    _padding: '',
  }
  const shell = JSON.stringify(base)
  const paddingNeeded = Math.max(0, sizeBytes - shell.length)
  base._padding = 'x'.repeat(paddingNeeded)
  return JSON.stringify(base)
}

async function probeHeaderSize(
  baseUrl: string,
  bytes: number
): Promise<number | string> {
  const header = makePipelineHeader(bytes)
  try {
    const res = await fetch(`${baseUrl}/pipeline_check`, {
      method: 'POST',
      headers: { 'X-Pipeline': header },
    })
    return res.status
  } catch (err: any) {
    return `error: ${err.cause?.code ?? err.message}`
  }
}

// ---------------------------------------------------------------------------
// Tests: production config (50 MB maxHeaderSize)
// ---------------------------------------------------------------------------

describe('X-Pipeline header size (maxHeaderSize: 50 MB)', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    const app = await createApp(resolver)
    const { serve } = await import('@hono/node-server')
    server = serve({
      fetch: app.fetch,
      port: 0,
      serverOptions: { maxHeaderSize: 50 * MB },
    }) as unknown as Server
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://localhost:${addr.port}`
  })

  afterAll(() => server?.close())

  it('accepts 1 MB header', async () => {
    expect(await probeHeaderSize(baseUrl, 1 * MB)).toBe(200)
  })

  it('accepts 10 MB header', async () => {
    expect(await probeHeaderSize(baseUrl, 10 * MB)).toBe(200)
  })

  it('accepts 30 MB header', async () => {
    expect(await probeHeaderSize(baseUrl, 30 * MB)).toBe(200)
  })
})
