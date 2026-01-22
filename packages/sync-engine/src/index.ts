import pkg from '../package.json' with { type: 'json' }

export const VERSION = pkg.version

export { StripeSync } from './stripeSync'

export type * from './types'

export { PostgresClient } from './database/postgres'
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export { embeddedMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { hashApiKey } from './utils/hashApiKey'
export { createStripeWebSocketClient } from './websocket-client'
export type {
  StripeWebSocketOptions,
  StripeWebSocketClient,
  StripeWebhookEvent,
  WebhookProcessingResult,
} from './websocket-client'
