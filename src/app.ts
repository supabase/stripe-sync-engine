import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import autoload from '@fastify/autoload'
import fastifySwagger from '@fastify/swagger'
import path from 'path'
import { errorSchema } from './schemas/error'

interface buildOpts extends FastifyServerOptions {
  exposeDocs?: boolean
}

export async function createServer(opts: buildOpts = {}): Promise<FastifyInstance> {
  const app = fastify(opts)

  /**
   * Expose swagger docs
   */
  if (opts.exposeDocs) {
    app.register(fastifySwagger, {
      swagger: {
        info: {
          title: 'Stripe Sync Engine',
          version: '0.0.1',
        },
      },
    })
  }

  /**
   * Add a content parser for stripe webhooks
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    try {
      let newBody
      switch (req.routerPath) {
        case '/webhooks':
          newBody = { raw: body }
          break
        default:
          newBody = JSON.parse(body.toString())
          break
      }
      done(null, newBody)
    } catch (error) {
      error.statusCode = 400
      done(error, undefined)
    }
  })

  /**
   * Add common schemas
   */
  app.addSchema(errorSchema)

  /**
   * Expose all routes in './routes'
   */
  app.register(autoload, {
    dir: path.join(__dirname, 'routes'),
  })

  await app.ready()

  return app
}
