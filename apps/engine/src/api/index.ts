#!/usr/bin/env node

import source from '@stripe/sync-source-stripe'
import pgDestination from '@stripe/sync-destination-postgres'
import sheetsDestination from '@stripe/sync-destination-google-sheets'
import { createConnectorResolver } from '../lib/index.js'
import { createApp } from './app.js'
import { logger } from '../logger.js'

const port = Number(process.env.PORT || 3001)

async function main() {
  if (process.env.DANGEROUSLY_VERBOSE_LOGGING === 'true') {
    logger.warn(
      '⚠️  DANGEROUSLY_VERBOSE_LOGGING is enabled — all request headers and message payloads will be logged. Do not use in production.'
    )
  }

  const resolver = await createConnectorResolver({
    sources: { stripe: source },
    destinations: { postgres: pgDestination, google_sheets: sheetsDestination },
  })
  const app = await createApp(resolver)

  // Use the web-standard fetch handler with the runtime's native server.
  // Bun.serve() properly cancels ReadableStreams on client disconnect;
  // @hono/node-server is the fallback for Node.js / tsx.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (globalThis as any).Bun !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).Bun.serve({ fetch: app.fetch, port, idleTimeout: 60 })
    logger.warn(
      { port, server: 'Bun.serve' },
      `Sync Engine API listening on http://localhost:${port}`
    )
  } else {
    const { serve } = await import('@hono/node-server')
    serve(
      {
        fetch: app.fetch,
        port,
        // Pipeline config and connector state are passed via the X-Pipeline header.
        // Node.js defaults to 16 KB which caps state at ~250 entries — too small for
        // connectors like google-sheets that carry row mappings. 50 MB is a conservative
        // ceiling; typical headers remain small. See docs/engine/header-size-limits.md
        serverOptions: { maxHeaderSize: 50 * 1024 * 1024 },
      },
      (info) => {
        logger.info({ port: info.port }, `Sync Engine API listening on http://localhost:${info.port}`)
      }
    )
  }
}

main()
