#!/usr/bin/env node

import { serve } from '@hono/node-server'
import { createConnectorResolver } from '../lib/index.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT || 3001)
const resolver = createConnectorResolver({})
const app = createApp(resolver)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Sync Engine API listening on http://localhost:${info.port}`)
})
