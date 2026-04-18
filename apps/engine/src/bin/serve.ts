#!/usr/bin/env node
import './bootstrap.js'
import { createConnectorResolver } from '../lib/index.js'
import { defaultConnectors } from '../lib/default-connectors.js'
import { startApiServer } from '../api/server.js'

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000
const resolver = await createConnectorResolver(defaultConnectors, {
  path: false,
  npm: false,
})

await startApiServer({ resolver, port })
