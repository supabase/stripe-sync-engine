import { StripeSync } from '@supabase/stripe-sync-engine'

declare module 'fastify' {
  interface FastifyInstance {
    stripeSync: StripeSync
  }
}
