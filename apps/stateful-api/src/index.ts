#!/usr/bin/env node

import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.PORT || 3002)
const app = createApp()

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Sync Engine Stateful API listening on http://localhost:${info.port}`)
})
