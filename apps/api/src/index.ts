import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@stripe/sync-protocol'
import { createApp } from './app'

// Source and destination must be provided — this is a placeholder entry point.
// In production, import concrete connectors and preload them in the resolver.
const port = Number(process.env.PORT || 3001)

console.log(`Sync Engine API requires source and destination connectors.`)
console.log(`See apps/api/src/app.ts for createApp() usage.`)
console.log()
console.log(`Example:`)
console.log(`  import { createApp } from './app'`)
console.log(`  import { createConnectorResolver } from '@stripe/sync-protocol'`)
console.log(`  import source from '@stripe/source-stripe'`)
console.log(`  import destination from '@stripe/destination-postgres'`)
console.log(
  `  const resolver = createConnectorResolver({ sources: { stripe: source }, destinations: { postgres: destination } })`
)
console.log(`  serve({ fetch: createApp(resolver).fetch, port: ${port} })`)

process.exit(1)
