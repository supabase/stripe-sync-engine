import type { FullConfig } from '@playwright/test'

let server: { close: (cb: (err?: unknown) => void) => void } | undefined

export default async function globalSetup(_config: FullConfig) {
  const { createApp, createConnectorResolver } = await import('@stripe/sync-engine')
  const sourceStripe = (await import('@stripe/sync-source-stripe')).default
  const destinationPostgres = (await import('@stripe/sync-destination-postgres')).default
  const destinationGoogleSheets = (await import('@stripe/sync-destination-google-sheets')).default
  const { serve } = await import('@hono/node-server')

  const resolver = createConnectorResolver({
    sources: { stripe: sourceStripe },
    destinations: { postgres: destinationPostgres, google_sheets: destinationGoogleSheets },
  })

  const app = createApp(resolver)

  server = serve({ fetch: app.fetch, port: 4010 }, () => {
    console.log('Engine started on port 4010 for e2e tests')
  })

  // Store cleanup for teardown
  ;(globalThis as Record<string, unknown>).__engineServer = server
}
