#!/usr/bin/env tsx

import { Readable } from 'node:stream'
import { createConnectorResolver } from '@stripe/sync-lib-stateless'
import { createCliFromSpec } from '@stripe/sync-ts-cli'
import { createApp } from '../api/app.js'
import { VERSION } from '../version.js'

const app = createApp(createConnectorResolver({}))
const spec = await (await app.fetch(new Request('http://localhost/openapi.json'))).json()

const root = createCliFromSpec({
  spec,
  handler: (req) => Promise.resolve(app.fetch(req)),
  exclude: ['health'],
  ndjsonBodyStream: () =>
    process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
})
root.name('sync-engine-stateless').version(VERSION)
root.parse()
