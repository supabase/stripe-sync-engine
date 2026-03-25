import { defineCommand } from 'citty'
import { serve } from '@hono/node-server'
import { createApp } from '../api/app.js'

export const main = defineCommand({
  meta: {
    name: 'sync-service',
    description: 'Stripe Sync Service — stateful sync with credential management',
  },
  args: {
    port: {
      type: 'string',
      description: 'HTTP server port',
      default: '4020',
    },
    'data-dir': {
      type: 'string',
      description: 'Data directory for file stores',
    },
  },
  run({ args }) {
    const port = Number(args.port)
    const app = createApp({ dataDir: args['data-dir'] || undefined })

    serve({ fetch: app.fetch, port }, () => {
      console.log(`Sync Service listening on http://localhost:${port}`)
      console.log(`Swagger UI: http://localhost:${port}/docs`)
    })
  },
})
