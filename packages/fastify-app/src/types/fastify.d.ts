import { StripeSync } from 'stripe-experiment-sync'

declare module 'fastify' {
  interface FastifyInstance {
    stripeSync: StripeSync
  }
}
