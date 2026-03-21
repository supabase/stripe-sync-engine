#!/usr/bin/env node
// Starts the stateless API with verbose error logging for e2e tests.
// Must be run with cwd = apps/stateless (so pnpm strict mode resolves deps).

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Dynamic imports resolved from CWD (not file location)
const appPath = pathToFileURL(resolve('dist/api/app.js')).href
const indexPath = pathToFileURL(resolve('dist/index.js')).href

const { createApp } = await import(appPath)
const { createConnectorResolver } = await import(indexPath)
const { serve } = await import('@hono/node-server')

const connectors = createConnectorResolver({})
const app = createApp({ connectors })

// Verbose error logging (built app swallows errors)
app.onError((err, c) => {
  console.error('[stateless-api] ERROR:', err)
  return c.json({ error: err.message }, 500)
})

const port = Number(process.env.PORT || 3458)
serve({ fetch: app.fetch, port })
console.log(`Stateless API listening on http://localhost:${port}`)
