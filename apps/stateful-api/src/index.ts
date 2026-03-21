#!/usr/bin/env node

import { serve } from '@hono/node-server'
import { createApp } from './app'

const port = Number(process.env.PORT || 3002)

const args = process.argv.slice(2)
const dataDirArgIdx = args.indexOf('--data-dir')
const dataDir = dataDirArgIdx !== -1 ? args[dataDirArgIdx + 1] : undefined

const app = createApp({ dataDir })

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Stripe Sync Stateful API listening on http://localhost:${info.port}`)
})
