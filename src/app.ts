import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import autoload from 'fastify-autoload'
import path from 'path'
import fastifySwagger from 'fastify-swagger'
import { errorSchema } from './schemas/error'

interface buildOpts extends FastifyServerOptions {
  exposeDocs?: boolean
}

const build = (opts: buildOpts = {}): FastifyInstance => {
  const app = fastify(opts)

  /**
   * Expose swagger docs
   */
  if (opts.exposeDocs) {
    app.register(fastifySwagger, {
      exposeRoute: true,
      swagger: {
        info: {
          title: 'Fastify Typescript Starter API',
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
      const newBody = {
        raw: body,
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
  return app
}

export default build
