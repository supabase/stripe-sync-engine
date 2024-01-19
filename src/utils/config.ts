import dotenv from 'dotenv'

type configType = {
  /** Postgres database URL including authentication */
  DATABASE_URL: string

  NODE_ENV: string

  /** Database schema name. */
  SCHEMA: string

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  STRIPE_SECRET_KEY: string

  /** Webhook secret from Stripe to verify the signature of webhook events. */
  STRIPE_WEBHOOK_SECRET: string

  /** API_KEY is used to authenticate requests to the sync-engine. */
  API_KEY: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  STRIPE_API_VERSION: string

  /** Port number the API is running on, defaults to 8080 */
  PORT: number
}

function getConfigFromEnv(key: string, defaultValue?: string): string {
  const value = process.env[key]
  if (!value && defaultValue === undefined) {
    throw new Error(`${key} is undefined`)
  }
  return value || defaultValue!
}

export function getConfig(): configType {
  dotenv.config()

  return {
    DATABASE_URL: getConfigFromEnv('DATABASE_URL'),
    SCHEMA: getConfigFromEnv('SCHEMA', 'stripe'),
    NODE_ENV: getConfigFromEnv('NODE_ENV'),
    STRIPE_SECRET_KEY: getConfigFromEnv('STRIPE_SECRET_KEY', ''),
    STRIPE_WEBHOOK_SECRET: getConfigFromEnv('STRIPE_WEBHOOK_SECRET'),
    API_KEY: getConfigFromEnv('API_KEY', 'false'),
    STRIPE_API_VERSION: getConfigFromEnv('STRIPE_API_VERSION', '2020-08-27'),
    PORT: Number(getConfigFromEnv('PORT', '8080')),
  }
}
