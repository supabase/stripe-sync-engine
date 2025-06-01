import { StripeSync } from '../stripeSync'

declare module 'fastify' {
  interface FastifyInstance {
    stripeSync: StripeSync
  }
}
