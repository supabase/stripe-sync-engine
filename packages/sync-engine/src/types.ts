import pino from 'pino'
import type Stripe from 'stripe'

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

export type SyncObject =
  | 'all'
  | 'customer'
  | 'invoice'
  | 'price'
  | 'product'
  | 'subscription'
  | 'subscription_schedules'
  | 'setup_intent'
  | 'payment_method'
  | 'dispute'
  | 'charge'
  | 'payment_intent'
  | 'plan'
  | 'tax_id'
  | 'credit_note'

export interface Sync {
  synced: number
}

export interface SyncBackfill {
  products?: Sync
  prices?: Sync
  plans?: Sync
  customers?: Sync
  subscriptions?: Sync
  subscriptionSchedules?: Sync
  invoices?: Sync
  setupIntents?: Sync
  paymentIntents?: Sync
  paymentMethods?: Sync
  disputes?: Sync
  charges?: Sync
  taxIds?: Sync
  creditNotes?: Sync
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
  backfillRelatedEntities?: boolean
}
