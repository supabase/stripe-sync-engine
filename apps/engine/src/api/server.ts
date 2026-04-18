import { serve } from '@hono/node-server'
import type { ConnectorResolver } from '../lib/index.js'
import { createApp } from './app.js'
import { logger } from '../logger.js'
import { ENGINE_SERVER_OPTIONS } from '../http-server-options.js'

export interface StartApiServerOptions {
  resolver: ConnectorResolver
  port: number
}

export async function startApiServer({ resolver, port }: StartApiServerOptions) {
  if (process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true') {
    logger.warn(
      '⚠️  DANGEROUSLY_VERBOSE_LOGGING is enabled — all request headers and message payloads will be logged. Do not use in production.'
    )
  }

  const app = await createApp(resolver)
  return serve(
    {
      fetch: app.fetch,
      port,
      serverOptions: ENGINE_SERVER_OPTIONS,
    },
    (info) => {
      logger.info({ port: info.port }, `Sync Engine listening on http://localhost:${info.port}`)
    }
  )
}
