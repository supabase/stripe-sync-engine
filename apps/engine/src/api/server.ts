import { serve } from '@hono/node-server'
import type { ConnectorResolver } from '../lib/index.js'
import { createApp } from './app.js'
import { log } from '../logger.js'
import { ENGINE_SERVER_OPTIONS } from '../http-server-options.js'

export interface StartApiServerOptions {
  resolver: ConnectorResolver
  port?: number
}

type BunLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serve: (options: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetch: (...args: any[]) => unknown
    port: number
    idleTimeout?: number
  }) => unknown
}

export interface ApiServerHandle {
  close: () => void
}

export async function startApiServer({
  resolver,
  port,
}: StartApiServerOptions): Promise<ApiServerHandle> {
  const listenPort = port ?? Number(process.env['PORT'] || 3000)

  const app = await createApp(resolver)
  const bun = (globalThis as typeof globalThis & { Bun?: BunLike }).Bun

  if (bun) {
    const server = bun.serve({ fetch: app.fetch, port: listenPort, idleTimeout: 60 })
    log.warn(
      { port: listenPort, server: 'Bun.serve' },
      `Sync Engine API listening on http://localhost:${listenPort}`
    )
    return { close: () => (server as { stop?: () => void }).stop?.() }
  }

  const server = serve(
    {
      fetch: app.fetch,
      port: listenPort,
      serverOptions: ENGINE_SERVER_OPTIONS,
    },
    (info) => {
      log.info({ port: info.port }, `Sync Engine API listening on http://localhost:${info.port}`)
    }
  )
  return { close: () => server.close() }
}
