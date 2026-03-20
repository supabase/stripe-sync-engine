import { serve } from '@hono/node-server'
import { app } from './app'

const port = Number(process.env.PORT || 4010)
console.log(`Sync API listening on http://localhost:${port}`)
console.log(`OpenAPI spec: http://localhost:${port}/openapi.json`)
console.log(`Swagger UI:   http://localhost:${port}/docs`)
serve({ fetch: app.fetch, port })
