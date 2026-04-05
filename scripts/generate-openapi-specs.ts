/**
 * Generate OpenAPI JSON specs from TypeScript source (no build required).
 * Writes engine and service specs to the paths given as CLI arguments.
 *
 * Usage: bun scripts/generate-openapi-specs.ts <engine_out> <service_out>
 */
import { writeFileSync } from 'node:fs'
import { createApp, createConnectorResolver } from '../apps/engine/src/index.js'
import { createApp as createServiceApp } from '../apps/service/src/api/app.js'
import sourceStripe from '../packages/source-stripe/src/index.js'
import destinationPostgres from '../packages/destination-postgres/src/index.js'
import destinationGoogleSheets from '../packages/destination-google-sheets/src/index.js'

const [engineOut, serviceOut] = process.argv.slice(2)
if (!engineOut || !serviceOut) {
  console.error('Usage: bun scripts/generate-openapi-specs.ts <engine_out> <service_out>')
  process.exit(1)
}

const resolver = await createConnectorResolver({
  sources: { stripe: (sourceStripe as any).default ?? sourceStripe },
  destinations: {
    postgres: (destinationPostgres as any).default ?? destinationPostgres,
    'google-sheets': (destinationGoogleSheets as any).default ?? destinationGoogleSheets,
  },
})

// Engine spec
const engineApp = await createApp(resolver)
const engineRes = await engineApp.request('/openapi.json')
const engineSpec = await engineRes.json()
writeFileSync(engineOut, JSON.stringify(engineSpec, null, 2) + '\n')

// Service spec
const mockClient = {
  start: async () => {},
  getHandle: () => ({
    signal: async () => {},
    query: async () => ({}),
    terminate: async () => {},
  }),
  list: async function* () {},
}
const serviceApp = createServiceApp({
  temporal: { client: mockClient as any, taskQueue: 'gen' },
  resolver,
})
const serviceRes = await serviceApp.request('/openapi.json')
const serviceSpec = await serviceRes.json()
writeFileSync(serviceOut, JSON.stringify(serviceSpec, null, 2) + '\n')
