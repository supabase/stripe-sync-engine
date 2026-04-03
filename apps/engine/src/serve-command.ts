import { serve } from '@hono/node-server'
import { createConnectorResolver } from './lib/index.js'
import { createApp } from './api/app.js'
import { parseJsonOrFile } from '@stripe/sync-ts-cli'
import { defaultConnectors } from './lib/default-connectors.js'
import { logger } from './logger.js'

export function serveAction(opts: {
  port?: number
  connectorsFromCommandMap?: string
  connectorsFromPath?: boolean
  connectorsFromNpm?: boolean
}) {
  const port = opts.port ?? Number(process.env['PORT'] || 3000)
  const resolver = createConnectorResolver(defaultConnectors, {
    commandMap: parseJsonOrFile(opts.connectorsFromCommandMap) as
      | Record<string, string>
      | undefined,
    path: opts.connectorsFromPath,
    npm: opts.connectorsFromNpm ?? false,
  })
  const app = createApp(resolver)
  serve({ fetch: app.fetch, port }, (info) => {
    logger.info({ port: info.port }, `Sync Engine listening on http://localhost:${info.port}`)
  })
}
