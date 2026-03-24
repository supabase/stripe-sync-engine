import { serve } from '@hono/node-server'
import { createConnectorResolver } from '@tx-stripe/stateless-sync'
import { createApp } from '@tx-stripe/sync-engine-stateless/app'
import { parseJsonOrFile } from '@tx-stripe/ts-cli'
import sourceStripe from '@tx-stripe/source-stripe'
import destinationPostgres from '@tx-stripe/destination-postgres'
import destinationGoogleSheets from '@tx-stripe/destination-google-sheets'

export function serveAction(opts: {
  port?: number
  connectorsFromCommandMap?: string
  connectorsFromPath?: boolean
  connectorsFromNpm?: boolean
}) {
  const port = opts.port ?? Number(process.env['PORT'] || 3000)
  const resolver = createConnectorResolver(
    {
      sources: { stripe: sourceStripe },
      destinations: {
        postgres: destinationPostgres,
        'destination-postgres': destinationPostgres,
        'google-sheets': destinationGoogleSheets,
        'destination-google-sheets': destinationGoogleSheets,
      },
    },
    {
      commandMap: parseJsonOrFile(opts.connectorsFromCommandMap) as
        | Record<string, string>
        | undefined,
      path: opts.connectorsFromPath,
      npm: opts.connectorsFromNpm ?? false,
    }
  )
  const app = createApp(resolver)
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Sync Engine listening on http://localhost:${info.port}`)
  })
}
