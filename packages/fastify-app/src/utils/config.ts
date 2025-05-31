import dotenv from 'dotenv'
import { logger } from '../logger'
import { StripeSyncConfig } from '@supabase/stripe-sync-engine'

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
