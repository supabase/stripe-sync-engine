#!/usr/bin/env node
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { createApp } from '../api/app.js'

const port = Number(process.env.PORT || 4020)
const app = createApp()

serve({ fetch: app.fetch, port }, () => {
  console.log(`Sync Service API listening on http://localhost:${port}`)
  console.log(`Swagger UI: http://localhost:${port}/docs`)
})
