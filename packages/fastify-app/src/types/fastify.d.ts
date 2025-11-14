import { StripeSync } from 'stripe-replit-sync'

declare module 'fastify' {
  interface FastifyInstance {
    stripeSync: StripeSync
  }
}
