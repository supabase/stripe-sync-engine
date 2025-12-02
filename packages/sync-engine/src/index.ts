export { StripeSync } from './stripeSync'

export type * from './types'

export { PostgresClient } from './database/postgres'
export { hashApiKey } from './utils/hashApiKey'

// Database adapter interface (no implementation - use stripe-replit-sync/pg or stripe-replit-sync/postgres-js)
export type { DatabaseAdapter } from './database/adapter'

// Note: runMigrations is exported from 'stripe-replit-sync/pg' since it uses pg directly
