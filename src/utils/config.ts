import dotenv from 'dotenv'
import pino from 'pino'
import { logger } from '../logger'

export type StripeSyncConfig = {
  /** Postgres database URL including authentication */
  databaseUrl: string

  nodeEnv: string

  /** Database schema name. */
  schema: string

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  stripeSecretKey: string

  /** Webhook secret from Stripe to verify the signature of webhook events. */
  stripeWebhookSecret: string

  /** API_KEY is used to authenticate "admin" endpoints (i.e. for backfilling), make sure to generate a secure string. */
  apiKey: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  stripeApiVersion: string

  /** Port number the API is running on, defaults to 8080 */
  port: number

  /**
   * Stripe limits related lists like invoice items in an invoice to 10 by default.
   * By enabling this, sync-engine automatically fetches the remaining elements before saving
   * */
  autoExpandLists: boolean

  /**
   * If true, the sync engine will backfill related entities, i.e. when a invoice webhook comes in, it ensures that the customer is present and synced.
   * This ensures foreign key integrity, but comes at the cost of additional queries to the database (and added latency for Stripe calls if the entity is actually missing).
   */
  backfillRelatedEntities: boolean

  maxPostgresConnections: number

  logger?: pino.Logger
}

function getConfigFromEnv(key: string, defaultValue?: string): string {
  const value = process.env[key]
  if (value == null && defaultValue === undefined) {
    throw new Error(`${key} is undefined`)
  }
  return value ?? defaultValue!
}

export function getConfig(): StripeSyncConfig {
  dotenv.config()

  return {
    databaseUrl: getConfigFromEnv('DATABASE_URL'),
    schema: getConfigFromEnv('SCHEMA', 'stripe'),
    nodeEnv: getConfigFromEnv('NODE_ENV'),
    stripeSecretKey: getConfigFromEnv('STRIPE_SECRET_KEY', ''),
    stripeWebhookSecret: getConfigFromEnv('STRIPE_WEBHOOK_SECRET'),
    apiKey: getConfigFromEnv('API_KEY', 'false'),
    stripeApiVersion: getConfigFromEnv('STRIPE_API_VERSION', '2020-08-27'),
    port: Number(getConfigFromEnv('PORT', '8080')),
    autoExpandLists: getConfigFromEnv('AUTO_EXPAND_LISTS', 'false') === 'true',
    backfillRelatedEntities: getConfigFromEnv('BACKFILL_RELATED_ENTITIES', 'true') === 'true',
    maxPostgresConnections: Number(getConfigFromEnv('MAX_POSTGRES_CONNECTIONS', '10')),
    logger: logger,
  }
}
