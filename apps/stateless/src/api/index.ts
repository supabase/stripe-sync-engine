#!/usr/bin/env tsx

import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@stripe/stateless-sync'
import { createApp } from './app'

const port = Number(process.env.PORT || 3001)
const resolver = createConnectorResolver({})
const app = createApp(resolver)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Sync Engine API listening on http://localhost:${info.port}`)
})
