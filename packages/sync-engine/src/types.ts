import { type PoolConfig } from 'pg'
import Stripe from 'stripe'

/**
 * Simple logger interface compatible with both pino and console
 */
export interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

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

  /** Stripe secret key used to authenticate requests to the Stripe API. Defaults to empty string */
  stripeSecretKey: string

  /** Stripe account ID. If not provided, will be retrieved from Stripe API. Used as fallback option. */
  stripeAccountId?: string

  /** Stripe webhook signing secret for validating webhook signatures. Required if not using managed webhooks. */
  stripeWebhookSecret?: string

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

  logger?: Logger

  /**
   * Maximum number of retry attempts for 429 rate limit errors.
   * Default: 5
   */
  maxRetries?: number

  /**
   * Initial delay in milliseconds before first retry attempt.
   * Delay increases exponentially: 1s, 2s, 4s, 8s, 16s, etc.
   * Default: 1000 (1 second)
   */
  initialRetryDelayMs?: number

  /**
   * Maximum delay in milliseconds between retry attempts.
   * Default: 60000 (60 seconds)
   */
  maxRetryDelayMs?: number

  /**
   * Random jitter in milliseconds added to retry delays to prevent thundering herd.
   * Default: 500
   */
  retryJitterMs?: number

  /**
   * Maximum number of customers to process concurrently when syncing payment methods.
   * Lower values reduce API load but increase sync time.
   * Default: 10
   */
  maxConcurrentCustomers?: number
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

export interface SyncParams {
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

/**
 * Result of processing a single page of items via processNext()
 */
export interface ProcessNextResult {
  /** Number of items processed in this page */
  processed: number
  /** Whether there are more items to process */
  hasMore: boolean
  /** The sync run this processing belongs to */
  runStartedAt: Date
}

/**
 * Parameters for processNext() including optional run context
 */
export interface ProcessNextParams extends SyncParams {
  /** Join an existing sync run instead of creating a new one */
  runStartedAt?: Date
  /** Who/what triggered this sync (for observability) */
  triggeredBy?: string
}

/**
 * Installation status of the stripe-sync package
 */
export type InstallationStatus = 'not_installed' | 'installing' | 'installed' | 'error'

/**
 * Sync status for a single account (from sync_runs view)
 */
export interface StripeSyncAccountState {
  account_id: string
  started_at: string
  closed_at: string | null
  status: 'pending' | 'running' | 'complete' | 'error'
  error_message: string | null
  total_processed: number
  total_objects: number
  complete_count: number
  error_count: number
  running_count: number
  pending_count: number
  triggered_by: string
  max_concurrent: number
}

/**
 * Response schema for the sync status endpoint
 */
export interface StripeSyncState {
  package_version: string
  installation_status: InstallationStatus
  sync_status: StripeSyncAccountState[]
}
