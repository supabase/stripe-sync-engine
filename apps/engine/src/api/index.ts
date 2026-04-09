#!/usr/bin/env node

import { serve } from '@hono/node-server'
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

  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, `Sync Engine API listening on http://localhost:${info.port}`)
  })
}

main()
