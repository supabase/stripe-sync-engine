#!/usr/bin/env node
import { startApiServer } from '../api/server.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import { createConnectorResolver } from '../lib/index.js'
import { bootstrap } from './bootstrap.js'

bootstrap()

const resolver = await createConnectorResolver(defaultConnectors, {
  path: false,
  npm: false,
})

await startApiServer({
  resolver,
  port: process.env['PORT'] ? Number(process.env['PORT']) : undefined,
})
