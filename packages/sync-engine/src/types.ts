import { type PoolConfig } from 'pg'
import pino from 'pino'
import Stripe from 'stripe'

export type RevalidateEntity =
  | 'charge'
  | 'credit_note'
  | 'customer'
  | 'dispute'
  | 'invoice'
  | 'payment_intent'
  | 'payment_method'
  | 'plan'
  | 'price'
  | 'product'
  | 'refund'
  | 'review'
  | 'radar.early_fraud_warning'
  | 'setup_intent'
  | 'subscription'
  | 'subscription_schedule'
  | 'tax_id'
  | 'entitlements'

export type StripeSyncConfig = {
  /** @deprecated Use `poolConfig` with a connection string instead. */
  databaseUrl?: string

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

  /**
   * If true, the webhook data is not used and instead the webhook is just a trigger to fetch the entity from Stripe again. This ensures that a race condition with failed webhooks can never accidentally overwrite the data with an older state.
   *
   * Default: false
   */
  revalidateObjectsViaStripeApi?: Array<RevalidateEntity>

  /** @deprecated Use `poolConfig` instead. */
  maxPostgresConnections?: number

  poolConfig: PoolConfig

  logger?: pino.Logger
}

export type SyncObject =
  | 'all'
  | 'customer'
  | 'customer_with_entitlements'
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
  | 'early_fraud_warning'
  | 'refund'
  | 'checkout_sessions'
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
  earlyFraudWarnings?: Sync
  refunds?: Sync
  checkoutSessions?: Sync
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

export interface SyncEntitlementsParams {
  object: 'entitlements'
  customerId: string
  pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>
}
export interface SyncFeaturesParams {
  object: 'features'
  pagination?: Pick<Stripe.PaginationParams, 'starting_after' | 'ending_before'>
}
