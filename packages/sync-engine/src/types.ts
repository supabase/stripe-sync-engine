import pino from 'pino'

export type StripeSyncConfig = {
  /** Postgres database URL including authentication */
  databaseUrl: string

  /** Database schema name. */
  schema?: string

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  stripeSecretKey: string

  /** Webhook secret from Stripe to verify the signature of webhook events. */
  stripeWebhookSecret: string

  /** Stripe API version for the webhooks, defaults to 2020-08-27 */
  stripeApiVersion?: string

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
  created?: {
    /**
     * Minimum value to filter by (exclusive)
     */
    gt?: number

    /**
     * Minimum value to filter by (inclusive)
     */
    gte?: number

    /**
     * Maximum value to filter by (exclusive)
     */
    lt?: number

    /**
     * Maximum value to filter by (inclusive)
     */
    lte?: number
  }
  object?: SyncObject
  backfillRelatedEntities?: boolean
}
