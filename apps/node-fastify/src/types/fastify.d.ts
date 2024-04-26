import { StripeSyncEngine } from 'stripe-sync-engine-lib'

declare module 'fastify' {
  interface FastifyInstance {
    stripeSyncEngine: StripeSyncEngine
  }
}
