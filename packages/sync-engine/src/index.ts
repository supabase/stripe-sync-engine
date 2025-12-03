import pkg from '../package.json' with { type: 'json' }

export const VERSION = pkg.version

export { StripeSync } from './stripeSync'

export type * from './types'

export { PostgresClient } from './database/postgres'
export { runMigrations } from './database/migrate'
export { hashApiKey } from './utils/hashApiKey'
