#!/usr/bin/env tsx

import 'dotenv/config'
import { Readable } from 'node:stream'
import { runMain } from 'citty'
import { createCliFromSpec } from '@stripe/sync-ts-cli'
import { createApp } from '../api/app.js'

const dataDirIdx = process.argv.indexOf('--data-dir')
const dataDir = dataDirIdx !== -1 ? process.argv[dataDirIdx + 1] : undefined

const app = createApp({ dataDir })
const spec = await (await app.fetch(new Request('http://localhost/openapi.json'))).json()

const root = createCliFromSpec({
  spec,
  handler: (req) => Promise.resolve(app.fetch(req)),
  exclude: ['health', 'pushWebhook'],
  ndjsonBodyStream: () =>
    process.stdin.isTTY ? null : (Readable.toWeb(process.stdin) as ReadableStream),
  meta: { name: 'sync-engine-stateful', version: '0.1.0' },
  rootArgs: {
    dataDir: {
      type: 'string',
      description: 'Data directory for credentials, syncs, state, and logs',
    },
  },
})
runMain(root)
