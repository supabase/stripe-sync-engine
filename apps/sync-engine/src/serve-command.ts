import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@stripe/stateless-sync'
import { createApp } from '@stripe/sync-engine-stateless/app'

export function serveAction(opts: { port?: number }) {
  const port = opts.port ?? Number(process.env['PORT'] || 3000)
  const resolver = createConnectorResolver({})
  const app = createApp(resolver)
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Sync Engine listening on http://localhost:${info.port}`)
  })
}
