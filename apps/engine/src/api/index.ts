#!/usr/bin/env node

import { serve } from '@hono/node-server'
import source from '@stripe/sync-source-stripe'
import pgDestination from '@stripe/sync-destination-postgres'
import sheetsDestination from '@stripe/sync-destination-google-sheets'
import { createConnectorResolver } from '../lib/index.js'
import { createApp } from './app.js'
import { logger } from '../logger.js'

const port = Number(process.env.PORT || 3001)
const resolver = createConnectorResolver({
  sources: { stripe: source },
  destinations: { postgres: pgDestination, 'google-sheets': sheetsDestination },
})
const app = createApp(resolver)

serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, `Sync Engine API listening on http://localhost:${info.port}`)
})
