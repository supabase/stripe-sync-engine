import type { RevalidateEntity } from 'stripe-experiment-sync'
import { config } from 'dotenv'
import type { ConnectionOptions } from 'node:tls'

function getConfigFromEnv(key: string, defaultValue?: string): string {
  const value = process.env[key]
  if (value == null && defaultValue === undefined) {
    throw new Error(`${key} is undefined`)
  }
  return value ?? defaultValue!
}

export type StripeSyncServerConfig = {
  /** Postgres database URL including authentication */
  databaseUrl: string

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  stripeSecretKey: string

  /** Webhook secret from Stripe to verify the signature of webhook events. */
  stripeWebhookSecret: string

  /** API_KEY is used to authenticate "admin" endpoints (i.e. for backfilling), make sure to generate a secure string. */
  apiKey: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  stripeApiVersion: string

  /**
   * Stripe limits related lists like invoice items in an invoice to 10 by default.
   * By enabling this, sync-engine automatically fetches the remaining elements before saving
   * */
  autoExpandLists?: boolean

  /**
   * If true, the sync engine will backfill related entities, i.e. when a invoice webhook comes in, it ensures that the customer is present and synced.
   * This ensures foreign key integrity, but comes at the cost of additional queries to the database (and added latency for Stripe calls if the entity is actually missing).
   */
  backfillRelatedEntities?: boolean

  maxPostgresConnections?: number

  revalidateObjectsViaStripeApi: Array<RevalidateEntity>

  port: number
  disableMigrations: boolean
  sslConnectionOptions?: ConnectionOptions
}

export function getConfig(): StripeSyncServerConfig {
  config()

  return {
    databaseUrl: getConfigFromEnv('DATABASE_URL'),
    stripeSecretKey: getConfigFromEnv('STRIPE_SECRET_KEY', ''),
    stripeWebhookSecret: getConfigFromEnv('STRIPE_WEBHOOK_SECRET'),
    apiKey: getConfigFromEnv('API_KEY', 'false'),
    stripeApiVersion: getConfigFromEnv('STRIPE_API_VERSION', '2020-08-27'),
    port: Number(getConfigFromEnv('PORT', '8080')),
    autoExpandLists: getConfigFromEnv('AUTO_EXPAND_LISTS', 'false') === 'true',
    backfillRelatedEntities: getConfigFromEnv('BACKFILL_RELATED_ENTITIES', 'true') === 'true',
    maxPostgresConnections: Number(getConfigFromEnv('MAX_POSTGRES_CONNECTIONS', '10')),
    revalidateObjectsViaStripeApi: getConfigFromEnv('REVALIDATE_OBJECTS_VIA_STRIPE_API', '')
      .split(',')
      .map((it) => it.trim())
      .filter((it) => it.length > 0) as Array<RevalidateEntity>,
    disableMigrations: getConfigFromEnv('DISABLE_MIGRATIONS', 'false') === 'true',
    sslConnectionOptions: sslConnnectionOptionsFromEnv(),
  }
}

function sslConnnectionOptionsFromEnv(): ConnectionOptions | undefined {
  const pgSslConfigEnabled = getConfigFromEnv('PG_SSL_CONFIG_ENABLED', 'false') === 'true'
  const pgSslRejectedUnauthorized =
    getConfigFromEnv('PG_SSL_REJECT_UNAUTHORIZED', 'false') === 'true'
  const pgSslCa = getConfigFromEnv('PG_SSL_CA', '')
  const pgSslCert = getConfigFromEnv('PG_SSL_CERT', '')
  const pgSslRequestCert = getConfigFromEnv('PG_SSL_REQUEST_CERT', 'false') === 'true'

  if (pgSslConfigEnabled) {
    return {
      rejectUnauthorized: pgSslRejectedUnauthorized,
      ca: pgSslCa ? pgSslCa : undefined,
      requestCert: pgSslRequestCert,
      cert: pgSslCert ? pgSslCert : undefined,
    }
  } else {
    return undefined
  }
}
