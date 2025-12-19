import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import pkg from '../package.json' with { type: 'json' }
import { PostgresClient } from './database/postgres'
import {
  StripeSyncConfig,
  Sync,
  SyncBackfill,
  SyncParams,
  SyncEntitlementsParams,
  SyncFeaturesParams,
  ProcessNextResult,
  ProcessNextParams,
  SyncObject,
  type RevalidateEntity,
  type ResourceConfig,
} from './types'
import { managedWebhookSchema } from './schemas/managed_webhook'
import { type PoolConfig } from 'pg'
import { createRetryableStripeClient } from './utils/stripeClientWrapper'
import { hashApiKey } from './utils/hashApiKey'
import { parseCsvObjects, runSigmaQueryAndDownloadCsv } from './sigma/sigmaApi'
import { SIGMA_INGESTION_CONFIGS } from './sigma/sigmaIngestionConfigs'
import {
  buildSigmaQuery,
  defaultSigmaRowToEntry,
  sigmaCursorFromEntry,
  type SigmaIngestionConfig,
} from './sigma/sigmaIngestion'

/**
 * Identifies a specific sync run.
 */
export type RunKey = {
  accountId: string
  runStartedAt: Date
}

function getUniqueIds<T>(entries: T[], key: string): string[] {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key as keyof T]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}

export interface StripeSyncOptions {
  databaseUrl: string
  stripeApiKey: string
  baseUrl: () => string
  webhookPath?: string
  stripeApiVersion?: string
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
  keepWebhooksOnShutdown?: boolean
}

export interface StripSyncInfo {
  baseUrl: string
  webhookUrl: string
}

export class StripeSync {
  stripe: Stripe
  postgresClient: PostgresClient

  constructor(private config: StripeSyncConfig) {
    // Create base Stripe client
    const baseStripe = new Stripe(config.stripeSecretKey, {
      // https://github.com/stripe/stripe-node#configuration
      // @ts-ignore
      apiVersion: config.stripeApiVersion,
      appInfo: {
        name: 'Stripe Sync Engine',
        version: pkg.version,
        url: pkg.homepage,
      },
    })

    // Wrap with automatic retry logic for all API calls
    // This ensures ALL Stripe operations are protected against:
    // - Rate limits (429)
    // - Server errors (500, 502, 503, 504, 424)
    // - Connection errors (network failures)
    this.stripe = createRetryableStripeClient(baseStripe, {}, config.logger)

    this.config.logger = config.logger ?? console
    this.config.logger?.info(
      { autoExpandLists: config.autoExpandLists, stripeApiVersion: config.stripeApiVersion },
      'StripeSync initialized'
    )

    const poolConfig = config.poolConfig ?? ({} as PoolConfig)

    if (config.databaseUrl) {
      poolConfig.connectionString = config.databaseUrl
    }

    if (config.maxPostgresConnections) {
      poolConfig.max = config.maxPostgresConnections
    }

    if (poolConfig.max === undefined) {
      poolConfig.max = 10
    }

    if (poolConfig.keepAlive === undefined) {
      poolConfig.keepAlive = true
    }

    this.postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig,
    })
  }

  /**
   * Get the Stripe account ID. Delegates to getCurrentAccount() for the actual lookup.
   */
  async getAccountId(objectAccountId?: string): Promise<string> {
    const account = await this.getCurrentAccount(objectAccountId)
    if (!account) {
      throw new Error('Failed to retrieve Stripe account. Please ensure API key is valid.')
    }
    return account.id
  }

  /**
   * Upsert Stripe account information to the database
   * @param account - Stripe account object
   * @param apiKeyHash - SHA-256 hash of API key to store for fast lookups
   */
  private async upsertAccount(account: Stripe.Account, apiKeyHash: string): Promise<void> {
    try {
      await this.postgresClient.upsertAccount(
        {
          id: account.id,
          raw_data: account,
        },
        apiKeyHash
      )
    } catch (error) {
      this.config.logger?.error(error, 'Failed to upsert account to database')
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to upsert account to database: ${errorMessage}`)
    }
  }

  /**
   * Get the current account being synced. Uses database lookup by API key hash,
   * with fallback to Stripe API if not found (first-time setup or new API key).
   * @param objectAccountId - Optional account ID from event data (Connect scenarios)
   */
  async getCurrentAccount(objectAccountId?: string): Promise<Stripe.Account | null> {
    const apiKeyHash = hashApiKey(this.config.stripeSecretKey)

    // Try to lookup account from database using API key hash (fast path)
    try {
      const account = await this.postgresClient.getAccountByApiKeyHash(apiKeyHash)
      if (account) {
        return account as Stripe.Account
      }
    } catch (error) {
      this.config.logger?.warn(
        error,
        'Failed to lookup account by API key hash, falling back to API'
      )
    }

    // Not found in database - retrieve from Stripe API (first-time setup or new API key)
    try {
      const accountIdParam = objectAccountId || this.config.stripeAccountId
      const account = accountIdParam
        ? await this.stripe.accounts.retrieve(accountIdParam)
        : await this.stripe.accounts.retrieve()

      await this.upsertAccount(account, apiKeyHash)
      return account
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve account from Stripe API')
      return null
    }
  }

  /**
   * Get all accounts that have been synced to the database
   */
  async getAllSyncedAccounts(): Promise<Stripe.Account[]> {
    try {
      const accountsData = await this.postgresClient.getAllAccounts()
      return accountsData as Stripe.Account[]
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve accounts from database')
      throw new Error('Failed to retrieve synced accounts from database')
    }
  }

  /**
   * DANGEROUS: Delete an account and all associated data from the database
   * This operation cannot be undone!
   *
   * @param accountId - The Stripe account ID to delete
   * @param options - Options for deletion behavior
   * @param options.dryRun - If true, only count records without deleting (default: false)
   * @param options.useTransaction - If true, use transaction for atomic deletion (default: true)
   * @returns Deletion summary with counts and warnings
   */
  async dangerouslyDeleteSyncedAccountData(
    accountId: string,
    options?: {
      dryRun?: boolean
      useTransaction?: boolean
    }
  ): Promise<{
    deletedAccountId: string
    deletedRecordCounts: { [tableName: string]: number }
    warnings: string[]
  }> {
    const dryRun = options?.dryRun ?? false
    const useTransaction = options?.useTransaction ?? true

    this.config.logger?.info(
      `${dryRun ? 'Preview' : 'Deleting'} account ${accountId} (transaction: ${useTransaction})`
    )

    try {
      // Get record counts
      const counts = await this.postgresClient.getAccountRecordCounts(accountId)

      // Generate warnings
      const warnings: string[] = []
      let totalRecords = 0

      for (const [table, count] of Object.entries(counts)) {
        if (count > 0) {
          totalRecords += count
          warnings.push(`Will delete ${count} ${table} record${count !== 1 ? 's' : ''}`)
        }
      }

      if (totalRecords > 100000) {
        warnings.push(
          `Large dataset detected (${totalRecords} total records). Consider using useTransaction: false for better performance.`
        )
      }

      // Dry-run mode: just return counts
      if (dryRun) {
        this.config.logger?.info(`Dry-run complete: ${totalRecords} total records would be deleted`)
        return {
          deletedAccountId: accountId,
          deletedRecordCounts: counts,
          warnings,
        }
      }

      // Actual deletion
      const deletionCounts = await this.postgresClient.deleteAccountWithCascade(
        accountId,
        useTransaction
      )

      this.config.logger?.info(
        `Successfully deleted account ${accountId} with ${totalRecords} total records`
      )

      return {
        deletedAccountId: accountId,
        deletedRecordCounts: deletionCounts,
        warnings,
      }
    } catch (error) {
      this.config.logger?.error(error, `Failed to delete account ${accountId}`)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to delete account ${accountId}: ${errorMessage}`)
    }
  }

  async processWebhook(payload: Buffer | string, signature: string | undefined) {
    // Start with user-provided webhook secret if available (non-managed webhook)
    let webhookSecret: string | undefined = this.config.stripeWebhookSecret

    // If no user-provided secret, look up managed webhook secret from database
    if (!webhookSecret) {
      // Get account ID for this API key to find the correct webhook secret
      const accountId = await this.getAccountId()

      // Check if we have a managed webhook in the database for this specific account
      const result = await this.postgresClient.query(
        `SELECT secret FROM "stripe"."_managed_webhooks" WHERE account_id = $1 LIMIT 1`,
        [accountId]
      )

      if (result.rows.length > 0) {
        // Use secret from managed webhook for this specific account
        webhookSecret = result.rows[0].secret
      }
    }

    if (!webhookSecret) {
      throw new Error(
        'No webhook secret provided. Either create a managed webhook or configure stripeWebhookSecret.'
      )
    }

    // Verify webhook signature using the correct secret
    const event = await this.stripe.webhooks.constructEventAsync(payload, signature!, webhookSecret)

    return this.processEvent(event)
  }

  // Event handler registry - maps event types to handler functions
  // Note: Uses 'any' for event parameter to allow handlers with specific Stripe event types
  // (e.g., CustomerDeletedEvent, ProductDeletedEvent) which TypeScript won't accept
  // as contravariant parameters when using the base Stripe.Event type
  private readonly eventHandlers: Record<
    string,
    (event: any, accountId: string) => Promise<void> // eslint-disable-line @typescript-eslint/no-explicit-any
  > = {
    'charge.captured': this.handleChargeEvent.bind(this),
    'charge.expired': this.handleChargeEvent.bind(this),
    'charge.failed': this.handleChargeEvent.bind(this),
    'charge.pending': this.handleChargeEvent.bind(this),
    'charge.refunded': this.handleChargeEvent.bind(this),
    'charge.succeeded': this.handleChargeEvent.bind(this),
    'charge.updated': this.handleChargeEvent.bind(this),
    'customer.deleted': this.handleCustomerDeletedEvent.bind(this),
    'customer.created': this.handleCustomerEvent.bind(this),
    'customer.updated': this.handleCustomerEvent.bind(this),
    'checkout.session.async_payment_failed': this.handleCheckoutSessionEvent.bind(this),
    'checkout.session.async_payment_succeeded': this.handleCheckoutSessionEvent.bind(this),
    'checkout.session.completed': this.handleCheckoutSessionEvent.bind(this),
    'checkout.session.expired': this.handleCheckoutSessionEvent.bind(this),
    'customer.subscription.created': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.deleted': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.paused': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.pending_update_applied': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.pending_update_expired': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.trial_will_end': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.resumed': this.handleSubscriptionEvent.bind(this),
    'customer.subscription.updated': this.handleSubscriptionEvent.bind(this),
    'customer.tax_id.updated': this.handleTaxIdEvent.bind(this),
    'customer.tax_id.created': this.handleTaxIdEvent.bind(this),
    'customer.tax_id.deleted': this.handleTaxIdDeletedEvent.bind(this),
    'invoice.created': this.handleInvoiceEvent.bind(this),
    'invoice.deleted': this.handleInvoiceEvent.bind(this),
    'invoice.finalized': this.handleInvoiceEvent.bind(this),
    'invoice.finalization_failed': this.handleInvoiceEvent.bind(this),
    'invoice.paid': this.handleInvoiceEvent.bind(this),
    'invoice.payment_action_required': this.handleInvoiceEvent.bind(this),
    'invoice.payment_failed': this.handleInvoiceEvent.bind(this),
    'invoice.payment_succeeded': this.handleInvoiceEvent.bind(this),
    'invoice.upcoming': this.handleInvoiceEvent.bind(this),
    'invoice.sent': this.handleInvoiceEvent.bind(this),
    'invoice.voided': this.handleInvoiceEvent.bind(this),
    'invoice.marked_uncollectible': this.handleInvoiceEvent.bind(this),
    'invoice.updated': this.handleInvoiceEvent.bind(this),
    'product.created': this.handleProductEvent.bind(this),
    'product.updated': this.handleProductEvent.bind(this),
    'product.deleted': this.handleProductDeletedEvent.bind(this),
    'price.created': this.handlePriceEvent.bind(this),
    'price.updated': this.handlePriceEvent.bind(this),
    'price.deleted': this.handlePriceDeletedEvent.bind(this),
    'plan.created': this.handlePlanEvent.bind(this),
    'plan.updated': this.handlePlanEvent.bind(this),
    'plan.deleted': this.handlePlanDeletedEvent.bind(this),
    'setup_intent.canceled': this.handleSetupIntentEvent.bind(this),
    'setup_intent.created': this.handleSetupIntentEvent.bind(this),
    'setup_intent.requires_action': this.handleSetupIntentEvent.bind(this),
    'setup_intent.setup_failed': this.handleSetupIntentEvent.bind(this),
    'setup_intent.succeeded': this.handleSetupIntentEvent.bind(this),
    'subscription_schedule.aborted': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.canceled': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.completed': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.created': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.expiring': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.released': this.handleSubscriptionScheduleEvent.bind(this),
    'subscription_schedule.updated': this.handleSubscriptionScheduleEvent.bind(this),
    'payment_method.attached': this.handlePaymentMethodEvent.bind(this),
    'payment_method.automatically_updated': this.handlePaymentMethodEvent.bind(this),
    'payment_method.detached': this.handlePaymentMethodEvent.bind(this),
    'payment_method.updated': this.handlePaymentMethodEvent.bind(this),
    'charge.dispute.created': this.handleDisputeEvent.bind(this),
    'charge.dispute.funds_reinstated': this.handleDisputeEvent.bind(this),
    'charge.dispute.funds_withdrawn': this.handleDisputeEvent.bind(this),
    'charge.dispute.updated': this.handleDisputeEvent.bind(this),
    'charge.dispute.closed': this.handleDisputeEvent.bind(this),
    'payment_intent.amount_capturable_updated': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.canceled': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.created': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.partially_funded': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.payment_failed': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.processing': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.requires_action': this.handlePaymentIntentEvent.bind(this),
    'payment_intent.succeeded': this.handlePaymentIntentEvent.bind(this),
    'credit_note.created': this.handleCreditNoteEvent.bind(this),
    'credit_note.updated': this.handleCreditNoteEvent.bind(this),
    'credit_note.voided': this.handleCreditNoteEvent.bind(this),
    'radar.early_fraud_warning.created': this.handleEarlyFraudWarningEvent.bind(this),
    'radar.early_fraud_warning.updated': this.handleEarlyFraudWarningEvent.bind(this),
    'refund.created': this.handleRefundEvent.bind(this),
    'refund.failed': this.handleRefundEvent.bind(this),
    'refund.updated': this.handleRefundEvent.bind(this),
    'charge.refund.updated': this.handleRefundEvent.bind(this),
    'review.closed': this.handleReviewEvent.bind(this),
    'review.opened': this.handleReviewEvent.bind(this),
    'entitlements.active_entitlement_summary.updated':
      this.handleEntitlementSummaryEvent.bind(this),
  }

  // Resource registry - maps SyncObject → list/upsert operations for processNext()
  // Complements eventHandlers which maps event types → handlers for webhooks
  // Both registries share the same underlying upsert methods
  // Order field determines backfill sequence - parents before children for FK dependencies
  private readonly resourceRegistry: Record<string, ResourceConfig> = {
    product: {
      order: 1, // No dependencies
      listFn: (p) => this.stripe.products.list(p),
      upsertFn: (items, id) => this.upsertProducts(items as Stripe.Product[], id),
      supportsCreatedFilter: true,
    },
    price: {
      order: 2, // Depends on product
      listFn: (p) => this.stripe.prices.list(p),
      upsertFn: (items, id, bf) => this.upsertPrices(items as Stripe.Price[], id, bf),
      supportsCreatedFilter: true,
    },
    plan: {
      order: 3, // Depends on product
      listFn: (p) => this.stripe.plans.list(p),
      upsertFn: (items, id, bf) => this.upsertPlans(items as Stripe.Plan[], id, bf),
      supportsCreatedFilter: true,
    },
    customer: {
      order: 4, // No dependencies
      listFn: (p) => this.stripe.customers.list(p),
      upsertFn: (items, id) => this.upsertCustomers(items as Stripe.Customer[], id),
      supportsCreatedFilter: true,
    },
    subscription: {
      order: 5, // Depends on customer, price
      listFn: (p) => this.stripe.subscriptions.list(p),
      upsertFn: (items, id, bf) => this.upsertSubscriptions(items as Stripe.Subscription[], id, bf),
      supportsCreatedFilter: true,
    },
    subscription_schedules: {
      order: 6, // Depends on customer
      listFn: (p) => this.stripe.subscriptionSchedules.list(p),
      upsertFn: (items, id, bf) =>
        this.upsertSubscriptionSchedules(items as Stripe.SubscriptionSchedule[], id, bf),
      supportsCreatedFilter: true,
    },
    invoice: {
      order: 7, // Depends on customer, subscription
      listFn: (p) => this.stripe.invoices.list(p),
      upsertFn: (items, id, bf) => this.upsertInvoices(items as Stripe.Invoice[], id, bf),
      supportsCreatedFilter: true,
    },
    charge: {
      order: 8, // Depends on customer, invoice
      listFn: (p) => this.stripe.charges.list(p),
      upsertFn: (items, id, bf) => this.upsertCharges(items as Stripe.Charge[], id, bf),
      supportsCreatedFilter: true,
    },
    setup_intent: {
      order: 9, // Depends on customer
      listFn: (p) => this.stripe.setupIntents.list(p),
      upsertFn: (items, id, bf) => this.upsertSetupIntents(items as Stripe.SetupIntent[], id, bf),
      supportsCreatedFilter: true,
    },
    payment_method: {
      order: 10, // Depends on customer (special: iterates customers)
      listFn: (p) => this.stripe.paymentMethods.list(p),
      upsertFn: (items, id, bf) =>
        this.upsertPaymentMethods(items as Stripe.PaymentMethod[], id, bf),
      supportsCreatedFilter: false, // Requires customer param, can't filter by created
    },
    payment_intent: {
      order: 11, // Depends on customer
      listFn: (p) => this.stripe.paymentIntents.list(p),
      upsertFn: (items, id, bf) =>
        this.upsertPaymentIntents(items as Stripe.PaymentIntent[], id, bf),
      supportsCreatedFilter: true,
    },
    tax_id: {
      order: 12, // Depends on customer
      listFn: (p) => this.stripe.taxIds.list(p),
      upsertFn: (items, id, bf) => this.upsertTaxIds(items as Stripe.TaxId[], id, bf),
      supportsCreatedFilter: false, // taxIds don't support created filter
    },
    credit_note: {
      order: 13, // Depends on invoice
      listFn: (p) => this.stripe.creditNotes.list(p),
      upsertFn: (items, id, bf) => this.upsertCreditNotes(items as Stripe.CreditNote[], id, bf),
      supportsCreatedFilter: true, // credit_notes support created filter
    },
    dispute: {
      order: 14, // Depends on charge
      listFn: (p) => this.stripe.disputes.list(p),
      upsertFn: (items, id, bf) => this.upsertDisputes(items as Stripe.Dispute[], id, bf),
      supportsCreatedFilter: true,
    },
    early_fraud_warning: {
      order: 15, // Depends on charge
      listFn: (p) => this.stripe.radar.earlyFraudWarnings.list(p),
      upsertFn: (items, id) =>
        this.upsertEarlyFraudWarning(items as Stripe.Radar.EarlyFraudWarning[], id),
      supportsCreatedFilter: true,
    },
    refund: {
      order: 16, // Depends on charge
      listFn: (p) => this.stripe.refunds.list(p),
      upsertFn: (items, id, bf) => this.upsertRefunds(items as Stripe.Refund[], id, bf),
      supportsCreatedFilter: true,
    },
    checkout_sessions: {
      order: 17, // Depends on customer (optional)
      listFn: (p) => this.stripe.checkout.sessions.list(p),
      upsertFn: (items, id) => this.upsertCheckoutSessions(items as Stripe.Checkout.Session[], id),
      supportsCreatedFilter: true,
    },
    // Sigma-backed resources
    subscription_item_change_events_v2_beta: {
      order: 18,
      supportsCreatedFilter: false,
      sigma: SIGMA_INGESTION_CONFIGS.subscription_item_change_events_v2_beta,
    },
    exchange_rates_from_usd: {
      order: 19,
      supportsCreatedFilter: false,
      sigma: SIGMA_INGESTION_CONFIGS.exchange_rates_from_usd,
    },
  }

  async processEvent(event: Stripe.Event) {
    // Get account ID at start of event processing
    // Try to extract from event data object if present (Connect scenarios)
    const objectAccountId =
      event.data?.object && typeof event.data.object === 'object' && 'account' in event.data.object
        ? (event.data.object as { account?: string }).account
        : undefined
    const accountId = await this.getAccountId(objectAccountId)

    // Ensure account exists before processing event (required for foreign key constraints)
    await this.getCurrentAccount()

    const handler = this.eventHandlers[event.type]
    if (handler) {
      // Extract entity ID from event data for logging
      const entityId =
        event.data?.object && typeof event.data.object === 'object' && 'id' in event.data.object
          ? (event.data.object as { id: string }).id
          : 'unknown'
      this.config.logger?.info(`Received webhook ${event.id}: ${event.type} for ${entityId}`)

      await handler(event, accountId)
    } else {
      this.config.logger?.warn(
        `Received unhandled webhook event: ${event.type} (${event.id}). Ignoring.`
      )
    }
  }

  /**
   * Returns an array of all webhook event types that this sync engine can handle.
   * Useful for configuring webhook endpoints with specific event subscriptions.
   */
  public getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[] {
    return Object.keys(
      this.eventHandlers
    ).sort() as Stripe.WebhookEndpointCreateParams.EnabledEvent[]
  }

  /**
   * Returns an array of all object types that can be synced via processNext/processUntilDone.
   * Ordered for backfill: parents before children (products before prices, customers before subscriptions).
   * Order is determined by the `order` field in resourceRegistry.
   */
  public getSupportedSyncObjects(): Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] {
    const all = Object.entries(this.resourceRegistry)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key) as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]

    // Only advertise Sigma-backed objects when explicitly enabled (opt-in).
    if (!this.config.enableSigma) {
      return all.filter(
        (o) => o !== 'subscription_item_change_events_v2_beta' && o !== 'exchange_rates_from_usd'
      ) as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]
    }

    return all
  }

  // Event handler methods
  private async handleChargeEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: charge, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Charge,
      (id) => this.stripe.charges.retrieve(id),
      (charge) => charge.status === 'failed' || charge.status === 'succeeded'
    )

    await this.upsertCharges([charge], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handleCustomerDeletedEvent(
    event: Stripe.CustomerDeletedEvent,
    accountId: string
  ): Promise<void> {
    const customer: Stripe.DeletedCustomer = {
      id: event.data.object.id,
      object: 'customer',
      deleted: true,
    }

    await this.upsertCustomers([customer], accountId, this.getSyncTimestamp(event, false))
  }

  private async handleCustomerEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: customer, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Customer | Stripe.DeletedCustomer,
      (id) => this.stripe.customers.retrieve(id),
      (customer) => customer.deleted === true
    )

    await this.upsertCustomers([customer], accountId, this.getSyncTimestamp(event, refetched))
  }

  private async handleCheckoutSessionEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: checkoutSession, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Checkout.Session,
      (id) => this.stripe.checkout.sessions.retrieve(id)
    )

    await this.upsertCheckoutSessions(
      [checkoutSession],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleSubscriptionEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: subscription, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Subscription,
      (id) => this.stripe.subscriptions.retrieve(id),
      (subscription) =>
        subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
    )

    await this.upsertSubscriptions(
      [subscription],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleTaxIdEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: taxId, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.TaxId,
      (id) => this.stripe.taxIds.retrieve(id)
    )

    await this.upsertTaxIds([taxId], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handleTaxIdDeletedEvent(event: Stripe.Event, _accountId: string): Promise<void> {
    const taxId = event.data.object as Stripe.TaxId

    await this.deleteTaxId(taxId.id)
  }

  private async handleInvoiceEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: invoice, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Invoice,
      (id) => this.stripe.invoices.retrieve(id),
      (invoice) => invoice.status === 'void'
    )

    await this.upsertInvoices([invoice], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handleProductEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: product, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Product,
        (id) => this.stripe.products.retrieve(id)
      )

      await this.upsertProducts([product], accountId, this.getSyncTimestamp(event, refetched))
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const product = event.data.object as Stripe.Product
        await this.deleteProduct(product.id)
      } else {
        throw err
      }
    }
  }

  private async handleProductDeletedEvent(
    event: Stripe.ProductDeletedEvent,
    _accountId: string
  ): Promise<void> {
    const product = event.data.object

    await this.deleteProduct(product.id)
  }

  private async handlePriceEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: price, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Price,
        (id) => this.stripe.prices.retrieve(id)
      )

      await this.upsertPrices([price], accountId, false, this.getSyncTimestamp(event, refetched))
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const price = event.data.object as Stripe.Price
        await this.deletePrice(price.id)
      } else {
        throw err
      }
    }
  }

  private async handlePriceDeletedEvent(
    event: Stripe.PriceDeletedEvent,
    _accountId: string
  ): Promise<void> {
    const price = event.data.object

    await this.deletePrice(price.id)
  }

  private async handlePlanEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: plan, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Plan,
        (id) => this.stripe.plans.retrieve(id)
      )

      await this.upsertPlans([plan], accountId, false, this.getSyncTimestamp(event, refetched))
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const plan = event.data.object as Stripe.Plan
        await this.deletePlan(plan.id)
      } else {
        throw err
      }
    }
  }

  private async handlePlanDeletedEvent(
    event: Stripe.PlanDeletedEvent,
    _accountId: string
  ): Promise<void> {
    const plan = event.data.object

    await this.deletePlan(plan.id)
  }

  private async handleSetupIntentEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: setupIntent, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.SetupIntent,
      (id) => this.stripe.setupIntents.retrieve(id),
      (setupIntent) => setupIntent.status === 'canceled' || setupIntent.status === 'succeeded'
    )

    await this.upsertSetupIntents(
      [setupIntent],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleSubscriptionScheduleEvent(
    event: Stripe.Event,
    accountId: string
  ): Promise<void> {
    const { entity: subscriptionSchedule, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.SubscriptionSchedule,
      (id) => this.stripe.subscriptionSchedules.retrieve(id),
      (schedule) => schedule.status === 'canceled' || schedule.status === 'completed'
    )

    await this.upsertSubscriptionSchedules(
      [subscriptionSchedule],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handlePaymentMethodEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: paymentMethod, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.PaymentMethod,
      (id) => this.stripe.paymentMethods.retrieve(id)
    )

    await this.upsertPaymentMethods(
      [paymentMethod],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleDisputeEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: dispute, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Dispute,
      (id) => this.stripe.disputes.retrieve(id),
      (dispute) => dispute.status === 'won' || dispute.status === 'lost'
    )

    await this.upsertDisputes([dispute], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handlePaymentIntentEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: paymentIntent, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.PaymentIntent,
      (id) => this.stripe.paymentIntents.retrieve(id),
      // Final states - do not re-fetch from API
      (entity) => entity.status === 'canceled' || entity.status === 'succeeded'
    )

    await this.upsertPaymentIntents(
      [paymentIntent],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleCreditNoteEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: creditNote, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.CreditNote,
      (id) => this.stripe.creditNotes.retrieve(id),
      (creditNote) => creditNote.status === 'void'
    )

    await this.upsertCreditNotes(
      [creditNote],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleEarlyFraudWarningEvent(
    event: Stripe.Event,
    accountId: string
  ): Promise<void> {
    const { entity: earlyFraudWarning, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Radar.EarlyFraudWarning,
      (id) => this.stripe.radar.earlyFraudWarnings.retrieve(id)
    )

    await this.upsertEarlyFraudWarning(
      [earlyFraudWarning],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private async handleRefundEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: refund, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Refund,
      (id) => this.stripe.refunds.retrieve(id)
    )

    await this.upsertRefunds([refund], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handleReviewEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: review, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Review,
      (id) => this.stripe.reviews.retrieve(id)
    )

    await this.upsertReviews([review], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  private async handleEntitlementSummaryEvent(
    event: Stripe.Event,
    accountId: string
  ): Promise<void> {
    const activeEntitlementSummary = event.data
      .object as Stripe.Entitlements.ActiveEntitlementSummary
    let entitlements = activeEntitlementSummary.entitlements
    let refetched = false
    if (this.config.revalidateObjectsViaStripeApi?.includes('entitlements')) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { lastResponse, ...rest } = await this.stripe.entitlements.activeEntitlements.list({
        customer: activeEntitlementSummary.customer,
      })
      entitlements = rest
      refetched = true
    }

    await this.deleteRemovedActiveEntitlements(
      activeEntitlementSummary.customer,
      entitlements.data.map((entitlement) => entitlement.id)
    )
    await this.upsertActiveEntitlements(
      activeEntitlementSummary.customer,
      entitlements.data,
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  private getSyncTimestamp(event: Stripe.Event, refetched: boolean) {
    return refetched ? new Date().toISOString() : new Date(event.created * 1000).toISOString()
  }

  private shouldRefetchEntity(entity: { object: string }) {
    return this.config.revalidateObjectsViaStripeApi?.includes(entity.object as RevalidateEntity)
  }

  private async fetchOrUseWebhookData<T extends { id?: string; object: string }>(
    entity: T,
    fetchFn: (id: string) => Promise<T>,
    entityInFinalState?: (entity: T) => boolean
  ): Promise<{ entity: T; refetched: boolean }> {
    if (!entity.id) return { entity, refetched: false }

    // This can be used as an optimization to avoid re-fetching unnecessarily
    if (entityInFinalState && entityInFinalState(entity)) return { entity, refetched: false }

    if (this.shouldRefetchEntity(entity)) {
      const fetchedEntity = await fetchFn(entity.id!)
      return { entity: fetchedEntity, refetched: true }
    }

    return { entity, refetched: false }
  }

  async syncSingleEntity(stripeId: string) {
    const accountId = await this.getAccountId()
    if (stripeId.startsWith('cus_')) {
      return this.stripe.customers.retrieve(stripeId).then((it) => {
        if (!it || it.deleted) return

        return this.upsertCustomers([it], accountId)
      })
    } else if (stripeId.startsWith('in_')) {
      return this.stripe.invoices
        .retrieve(stripeId)
        .then((it) => this.upsertInvoices([it], accountId))
    } else if (stripeId.startsWith('price_')) {
      return this.stripe.prices.retrieve(stripeId).then((it) => this.upsertPrices([it], accountId))
    } else if (stripeId.startsWith('prod_')) {
      return this.stripe.products
        .retrieve(stripeId)
        .then((it) => this.upsertProducts([it], accountId))
    } else if (stripeId.startsWith('sub_')) {
      return this.stripe.subscriptions
        .retrieve(stripeId)
        .then((it) => this.upsertSubscriptions([it], accountId))
    } else if (stripeId.startsWith('seti_')) {
      return this.stripe.setupIntents
        .retrieve(stripeId)
        .then((it) => this.upsertSetupIntents([it], accountId))
    } else if (stripeId.startsWith('pm_')) {
      return this.stripe.paymentMethods
        .retrieve(stripeId)
        .then((it) => this.upsertPaymentMethods([it], accountId))
    } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
      return this.stripe.disputes
        .retrieve(stripeId)
        .then((it) => this.upsertDisputes([it], accountId))
    } else if (stripeId.startsWith('ch_')) {
      return this.stripe.charges
        .retrieve(stripeId)
        .then((it) => this.upsertCharges([it], accountId, true))
    } else if (stripeId.startsWith('pi_')) {
      return this.stripe.paymentIntents
        .retrieve(stripeId)
        .then((it) => this.upsertPaymentIntents([it], accountId))
    } else if (stripeId.startsWith('txi_')) {
      return this.stripe.taxIds.retrieve(stripeId).then((it) => this.upsertTaxIds([it], accountId))
    } else if (stripeId.startsWith('cn_')) {
      return this.stripe.creditNotes
        .retrieve(stripeId)
        .then((it) => this.upsertCreditNotes([it], accountId))
    } else if (stripeId.startsWith('issfr_')) {
      return this.stripe.radar.earlyFraudWarnings
        .retrieve(stripeId)
        .then((it) => this.upsertEarlyFraudWarning([it], accountId))
    } else if (stripeId.startsWith('prv_')) {
      return this.stripe.reviews
        .retrieve(stripeId)
        .then((it) => this.upsertReviews([it], accountId))
    } else if (stripeId.startsWith('re_')) {
      return this.stripe.refunds
        .retrieve(stripeId)
        .then((it) => this.upsertRefunds([it], accountId))
    } else if (stripeId.startsWith('feat_')) {
      return this.stripe.entitlements.features
        .retrieve(stripeId)
        .then((it) => this.upsertFeatures([it], accountId))
    } else if (stripeId.startsWith('cs_')) {
      return this.stripe.checkout.sessions
        .retrieve(stripeId)
        .then((it) => this.upsertCheckoutSessions([it], accountId))
    }
  }

  /**
   * Process one page of items for the specified object type.
   * Returns the number of items processed and whether there are more pages.
   *
   * This method is designed for queue-based consumption where each page
   * is processed as a separate job. Uses the observable sync system for tracking.
   *
   * @param object - The Stripe object type to sync (e.g., 'customer', 'product')
   * @param params - Optional parameters for filtering and run context
   * @returns ProcessNextResult with processed count, hasMore flag, and runStartedAt
   *
   * @example
   * ```typescript
   * // Queue worker
   * const { hasMore, runStartedAt } = await stripeSync.processNext('customer')
   * if (hasMore) {
   *   await queue.send({ object: 'customer', runStartedAt })
   * }
   * ```
   */
  async processNext(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    params?: ProcessNextParams
  ): Promise<ProcessNextResult> {
    // Ensure account exists before syncing
    await this.getCurrentAccount()
    const accountId = await this.getAccountId()

    // Map object type to resource name (database table)
    const resourceName = this.getResourceName(object)

    // Get or create sync run
    let runStartedAt: Date
    if (params?.runStartedAt) {
      runStartedAt = params.runStartedAt
    } else {
      const { runKey } = await this.joinOrCreateSyncRun(params?.triggeredBy ?? 'processNext')
      runStartedAt = runKey.runStartedAt
    }

    // Ensure object run exists
    await this.postgresClient.createObjectRuns(accountId, runStartedAt, [resourceName])

    // Check object status and try to claim if pending
    const objRun = await this.postgresClient.getObjectRun(accountId, runStartedAt, resourceName)
    if (objRun?.status === 'complete' || objRun?.status === 'error') {
      // Object already finished - return early
      return {
        processed: 0,
        hasMore: false,
        runStartedAt,
      }
    }

    // Try to start if pending (for first call on this object)
    if (objRun?.status === 'pending') {
      const started = await this.postgresClient.tryStartObjectSync(
        accountId,
        runStartedAt,
        resourceName
      )
      if (!started) {
        // At concurrency limit - return early
        return {
          processed: 0,
          hasMore: true,
          runStartedAt,
        }
      }
    }
    // If status is 'running', we continue processing (fetch next page)

    // Get cursor for incremental sync
    // If user provided explicit created filter, use null cursor
    // Otherwise, check current run's cursor, then fall back to last completed sync's cursor
    let cursor: string | null = null
    if (!params?.created) {
      if (objRun?.cursor) {
        // Continue from where we left off in current run
        cursor = objRun.cursor
      } else {
        // New run - start from last completed sync's cursor
        const lastCursor = await this.postgresClient.getLastCompletedCursor(accountId, resourceName)
        cursor = lastCursor ?? null
      }
    }

    // Fetch one page and upsert
    const result = await this.fetchOnePage(
      object,
      accountId,
      resourceName,
      runStartedAt,
      cursor,
      params
    )

    return result
  }

  /**
   * Get the database resource name for a SyncObject type
   */
  private getResourceName(object: SyncObject): string {
    const mapping: Record<string, string> = {
      customer: 'customers',
      invoice: 'invoices',
      price: 'prices',
      product: 'products',
      subscription: 'subscriptions',
      subscription_schedules: 'subscription_schedules',
      setup_intent: 'setup_intents',
      payment_method: 'payment_methods',
      dispute: 'disputes',
      charge: 'charges',
      payment_intent: 'payment_intents',
      plan: 'plans',
      tax_id: 'tax_ids',
      credit_note: 'credit_notes',
      early_fraud_warning: 'early_fraud_warnings',
      refund: 'refunds',
      checkout_sessions: 'checkout_sessions',
    }
    return mapping[object] || object
  }

  /**
   * Fetch one page of items from Stripe and upsert to database.
   * Uses resourceRegistry for DRY list/upsert operations.
   * Uses the observable sync system for tracking progress.
   */
  private async fetchOnePage(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    accountId: string,
    resourceName: string,
    runStartedAt: Date,
    cursor: string | null,
    params?: ProcessNextParams
  ): Promise<ProcessNextResult> {
    const limit = 100 // Stripe page size

    // Handle special cases that require customer context
    if (object === 'payment_method' || object === 'tax_id') {
      this.config.logger?.warn(`processNext for ${object} requires customer context`)
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
      return { processed: 0, hasMore: false, runStartedAt }
    }

    // Look up config from registry
    const config = this.resourceRegistry[object]
    if (!config) {
      throw new Error(`Unsupported object type for processNext: ${object}`)
    }

    try {
      if (config.sigma) {
        return await this.fetchOneSigmaPage(
          accountId,
          resourceName,
          runStartedAt,
          cursor,
          config.sigma
        )
      }

      // Build list parameters
      const listParams: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam } = { limit }
      if (config.supportsCreatedFilter) {
        const created =
          params?.created ??
          (cursor && /^\d+$/.test(cursor)
            ? ({ gte: Number.parseInt(cursor, 10) } as const)
            : undefined)
        if (created) {
          listParams.created = created
        }
      }

      // Fetch from Stripe
      const response = await config.listFn(listParams)

      // Upsert the data
      if (response.data.length > 0) {
        this.config.logger?.info(`processNext: upserting ${response.data.length} ${resourceName}`)
        await config.upsertFn(response.data, accountId, params?.backfillRelatedEntities)

        // Update progress
        await this.postgresClient.incrementObjectProgress(
          accountId,
          runStartedAt,
          resourceName,
          response.data.length
        )

        // Update cursor with max created from this batch
        const maxCreated = Math.max(
          ...response.data.map((i) => (i as { created?: number }).created || 0)
        )
        if (maxCreated > 0) {
          await this.postgresClient.updateObjectCursor(
            accountId,
            runStartedAt,
            resourceName,
            String(maxCreated)
          )
        }
      }

      // Mark complete if no more pages
      if (!response.has_more) {
        await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
      }

      return {
        processed: response.data.length,
        hasMore: response.has_more,
        runStartedAt,
      }
    } catch (error) {
      await this.postgresClient.failObjectSync(
        accountId,
        runStartedAt,
        resourceName,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error
    }
  }

  private async getSigmaFallbackCursorFromDestination(
    accountId: string,
    sigmaConfig: SigmaIngestionConfig
  ): Promise<string | null> {
    const cursorCols = sigmaConfig.cursor.columns
    const selectCols = cursorCols.map((c) => `"${c.column}"`).join(', ')
    const orderBy = cursorCols.map((c) => `"${c.column}" DESC`).join(', ')

    const result = await this.postgresClient.query(
      `SELECT ${selectCols}
       FROM "stripe"."${sigmaConfig.destinationTable}"
       WHERE "_account_id" = $1
       ORDER BY ${orderBy}
       LIMIT 1`,
      [accountId]
    )

    if (result.rows.length === 0) return null

    const row = result.rows[0] as Record<string, unknown>
    const entryForCursor: Record<string, unknown> = {}
    for (const c of cursorCols) {
      const v = row[c.column]
      if (v == null) {
        throw new Error(
          `Sigma fallback cursor query returned null for ${sigmaConfig.destinationTable}.${c.column}`
        )
      }
      if (c.type === 'timestamp') {
        const d = v instanceof Date ? v : new Date(String(v))
        if (Number.isNaN(d.getTime())) {
          throw new Error(
            `Sigma fallback cursor query returned invalid timestamp for ${sigmaConfig.destinationTable}.${c.column}: ${String(
              v
            )}`
          )
        }
        entryForCursor[c.column] = d.toISOString()
      } else {
        entryForCursor[c.column] = String(v)
      }
    }

    return sigmaCursorFromEntry(sigmaConfig, entryForCursor)
  }

  private async fetchOneSigmaPage(
    accountId: string,
    resourceName: string,
    runStartedAt: Date,
    cursor: string | null,
    sigmaConfig: SigmaIngestionConfig
  ): Promise<ProcessNextResult> {
    if (!this.config.stripeSecretKey) {
      throw new Error('Sigma sync requested but stripeSecretKey is not configured.')
    }
    if (resourceName !== sigmaConfig.destinationTable) {
      throw new Error(
        `Sigma sync config mismatch: resourceName=${resourceName} destinationTable=${sigmaConfig.destinationTable}`
      )
    }

    const effectiveCursor =
      cursor ?? (await this.getSigmaFallbackCursorFromDestination(accountId, sigmaConfig))
    const sigmaSql = buildSigmaQuery(sigmaConfig, effectiveCursor)

    this.config.logger?.info(
      { object: resourceName, pageSize: sigmaConfig.pageSize, hasCursor: Boolean(effectiveCursor) },
      'Sigma sync: running query'
    )

    const { queryRunId, fileId, csv } = await runSigmaQueryAndDownloadCsv({
      apiKey: this.config.stripeSecretKey,
      sql: sigmaSql,
      logger: this.config.logger,
    })

    const rows = parseCsvObjects(csv)
    if (rows.length === 0) {
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
      return { processed: 0, hasMore: false, runStartedAt }
    }

    const entries: Array<Record<string, unknown>> = rows.map((row) =>
      defaultSigmaRowToEntry(sigmaConfig, row)
    )

    this.config.logger?.info(
      { object: resourceName, rows: entries.length, queryRunId, fileId },
      'Sigma sync: upserting rows'
    )

    await this.postgresClient.upsertManyWithTimestampProtection(
      entries,
      resourceName,
      accountId,
      undefined,
      sigmaConfig.upsert
    )

    await this.postgresClient.incrementObjectProgress(
      accountId,
      runStartedAt,
      resourceName,
      entries.length
    )

    // Cursor: advance to the last row in the page (matches the ORDER BY in buildSigmaQuery()).
    const newCursor = sigmaCursorFromEntry(sigmaConfig, entries[entries.length - 1]!)
    await this.postgresClient.updateObjectCursor(accountId, runStartedAt, resourceName, newCursor)

    const hasMore = rows.length === sigmaConfig.pageSize
    if (!hasMore) {
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
    }

    return { processed: entries.length, hasMore, runStartedAt }
  }

  /**
   * Process all pages for all (or specified) object types until complete.
   *
   * @param params - Optional parameters for filtering and specifying object types
   * @returns SyncBackfill with counts for each synced resource type
   */
  /**
   * Process all pages for a single object type until complete.
   * Loops processNext() internally until hasMore is false.
   *
   * @param object - The object type to sync
   * @param runStartedAt - The sync run to use (for sharing across objects)
   * @param params - Optional sync parameters
   * @returns Sync result with count of synced items
   */
  private async processObjectUntilDone(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    runStartedAt: Date,
    params?: SyncParams
  ): Promise<Sync> {
    let totalSynced = 0

    while (true) {
      const result = await this.processNext(object, {
        ...params,
        runStartedAt,
        triggeredBy: 'processUntilDone',
      })
      totalSynced += result.processed

      if (!result.hasMore) {
        break
      }
    }

    return { synced: totalSynced }
  }

  /**
   * Join existing sync run or create a new one.
   * Returns sync run key and list of supported objects to sync.
   *
   * Cooperative behavior: If a sync run already exists, joins it instead of failing.
   * This is used by workers and background processes that should cooperate.
   *
   * @param triggeredBy - What triggered this sync (for observability)
   * @returns Run key and list of objects to sync
   */
  async joinOrCreateSyncRun(triggeredBy: string = 'worker'): Promise<{
    runKey: RunKey
    objects: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]
  }> {
    await this.getCurrentAccount()
    const accountId = await this.getAccountId()

    const result = await this.postgresClient.getOrCreateSyncRun(accountId, triggeredBy)
    if (!result) {
      const activeRun = await this.postgresClient.getActiveSyncRun(accountId)
      if (!activeRun) {
        throw new Error('Failed to get or create sync run')
      }
      return {
        runKey: { accountId: activeRun.accountId, runStartedAt: activeRun.runStartedAt },
        objects: this.getSupportedSyncObjects(),
      }
    }

    const { accountId: runAccountId, runStartedAt } = result
    return {
      runKey: { accountId: runAccountId, runStartedAt },
      objects: this.getSupportedSyncObjects(),
    }
  }

  async processUntilDone(params?: SyncParams): Promise<SyncBackfill> {
    const { object } = params ?? { object: 'all' }

    // Join or create sync run
    const { runKey } = await this.joinOrCreateSyncRun('processUntilDone')

    return this.processUntilDoneWithRun(runKey.runStartedAt, object, params)
  }

  /**
   * Internal implementation of processUntilDone with an existing run.
   */
  private async processUntilDoneWithRun(
    runStartedAt: Date,
    object: SyncObject | undefined,
    params?: SyncParams
  ): Promise<SyncBackfill> {
    const accountId = await this.getAccountId()

    const results: SyncBackfill = {}

    try {
      // Determine which objects to sync
      // getSupportedSyncObjects() returns objects in correct dependency order for backfills
      const objectsToSync: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] =
        object === 'all' || object === undefined
          ? this.getSupportedSyncObjects()
          : [object as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>]

      // Sync each object type
      for (const obj of objectsToSync) {
        this.config.logger?.info(`Syncing ${obj}`)

        // payment_method requires special handling (iterates customers)
        if (obj === 'payment_method') {
          results.paymentMethods = await this.syncPaymentMethodsWithRun(runStartedAt, params)
        } else {
          const result = await this.processObjectUntilDone(obj, runStartedAt, params)

          // Map object name to result field
          switch (obj) {
            case 'product':
              results.products = result
              break
            case 'price':
              results.prices = result
              break
            case 'plan':
              results.plans = result
              break
            case 'customer':
              results.customers = result
              break
            case 'subscription':
              results.subscriptions = result
              break
            case 'subscription_schedules':
              results.subscriptionSchedules = result
              break
            case 'invoice':
              results.invoices = result
              break
            case 'charge':
              results.charges = result
              break
            case 'setup_intent':
              results.setupIntents = result
              break
            case 'payment_intent':
              results.paymentIntents = result
              break
            case 'tax_id':
              results.taxIds = result
              break
            case 'credit_note':
              results.creditNotes = result
              break
            case 'dispute':
              results.disputes = result
              break
            case 'early_fraud_warning':
              results.earlyFraudWarnings = result
              break
            case 'refund':
              results.refunds = result
              break
            case 'checkout_sessions':
              results.checkoutSessions = result
              break
            case 'subscription_item_change_events_v2_beta':
              results.subscriptionItemChangeEventsV2Beta = result
              break
            case 'exchange_rates_from_usd':
              results.exchangeRatesFromUsd = result
              break
          }
        }
      }

      // Close the sync run after all objects are done (status derived from object states)
      await this.postgresClient.closeSyncRun(accountId, runStartedAt)

      return results
    } catch (error) {
      // Close the sync run on error (status will be 'error' based on failed object states)
      await this.postgresClient.closeSyncRun(accountId, runStartedAt)
      throw error
    }
  }

  /**
   * Sync payment methods with an existing run (special case - iterates customers)
   */
  private async syncPaymentMethodsWithRun(
    runStartedAt: Date,
    syncParams?: SyncParams
  ): Promise<Sync> {
    const accountId = await this.getAccountId()
    const resourceName = 'payment_methods'

    // Create object run
    await this.postgresClient.createObjectRuns(accountId, runStartedAt, [resourceName])
    await this.postgresClient.tryStartObjectSync(accountId, runStartedAt, resourceName)

    try {
      // Query customers from database
      const prepared = sql(
        `select id from "stripe"."customers" WHERE COALESCE(deleted, false) <> true;`
      )([])

      const customerIds = await this.postgresClient
        .query(prepared.text, prepared.values)
        .then(({ rows }) => rows.map((it) => it.id))

      this.config.logger?.info(`Getting payment methods for ${customerIds.length} customers`)

      let synced = 0

      // Process customers in parallel chunks (configurable concurrency)
      const chunkSize = this.config.maxConcurrentCustomers ?? 10
      for (const customerIdChunk of chunkArray(customerIds, chunkSize)) {
        await Promise.all(
          customerIdChunk.map(async (customerId) => {
            const CHECKPOINT_SIZE = 100
            let currentBatch: Stripe.PaymentMethod[] = []

            // Manual pagination - each fetch() gets automatic retry protection
            let hasMore = true
            let startingAfter: string | undefined = undefined

            while (hasMore) {
              const response: Stripe.ApiList<Stripe.PaymentMethod> =
                await this.stripe.paymentMethods.list({
                  limit: 100,
                  customer: customerId,
                  ...(startingAfter ? { starting_after: startingAfter } : {}),
                })

              for (const item of response.data) {
                currentBatch.push(item)
                if (currentBatch.length >= CHECKPOINT_SIZE) {
                  await this.upsertPaymentMethods(
                    currentBatch,
                    accountId,
                    syncParams?.backfillRelatedEntities
                  )
                  synced += currentBatch.length
                  await this.postgresClient.incrementObjectProgress(
                    accountId,
                    runStartedAt,
                    resourceName,
                    currentBatch.length
                  )
                  currentBatch = []
                }
              }

              hasMore = response.has_more
              if (response.data.length > 0) {
                startingAfter = response.data[response.data.length - 1].id
              }
            }

            // Process remaining items
            if (currentBatch.length > 0) {
              await this.upsertPaymentMethods(
                currentBatch,
                accountId,
                syncParams?.backfillRelatedEntities
              )
              synced += currentBatch.length
              await this.postgresClient.incrementObjectProgress(
                accountId,
                runStartedAt,
                resourceName,
                currentBatch.length
              )
            }
          })
        )
      }

      // Complete object run
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)

      return { synced }
    } catch (error) {
      await this.postgresClient.failObjectSync(
        accountId,
        runStartedAt,
        resourceName,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error
    }
  }

  async syncProducts(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing products')

    return this.withSyncRun('products', 'syncProducts', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.ProductListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.products.list({ ...params, ...pagination }),
        (products) => this.upsertProducts(products, accountId),
        accountId,
        'products',
        runStartedAt
      )
    })
  }

  async syncPrices(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing prices')

    return this.withSyncRun('prices', 'syncPrices', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.PriceListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.prices.list({ ...params, ...pagination }),
        (prices) => this.upsertPrices(prices, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'prices',
        runStartedAt
      )
    })
  }

  async syncPlans(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing plans')

    return this.withSyncRun('plans', 'syncPlans', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.PlanListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.plans.list({ ...params, ...pagination }),
        (plans) => this.upsertPlans(plans, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'plans',
        runStartedAt
      )
    })
  }

  async syncCustomers(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing customers')

    return this.withSyncRun('customers', 'syncCustomers', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.CustomerListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.customers.list({ ...params, ...pagination }),
        // @ts-expect-error
        (items) => this.upsertCustomers(items, accountId),
        accountId,
        'customers',
        runStartedAt
      )
    })
  }

  async syncSubscriptions(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscriptions')

    return this.withSyncRun('subscriptions', 'syncSubscriptions', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.subscriptions.list({ ...params, ...pagination }),
        (items) => this.upsertSubscriptions(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'subscriptions',
        runStartedAt
      )
    })
  }

  async syncSubscriptionSchedules(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscription schedules')

    return this.withSyncRun(
      'subscription_schedules',
      'syncSubscriptionSchedules',
      async (cursor, runStartedAt) => {
        const accountId = await this.getAccountId()
        const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }

        if (syncParams?.created) {
          params.created = syncParams.created
        } else if (cursor) {
          params.created = { gte: cursor }
          this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
        }

        return this.fetchAndUpsert(
          (pagination) => this.stripe.subscriptionSchedules.list({ ...params, ...pagination }),
          (items) =>
            this.upsertSubscriptionSchedules(items, accountId, syncParams?.backfillRelatedEntities),
          accountId,
          'subscription_schedules',
          runStartedAt
        )
      }
    )
  }

  async syncInvoices(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing invoices')

    return this.withSyncRun('invoices', 'syncInvoices', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.InvoiceListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.invoices.list({ ...params, ...pagination }),
        (items) => this.upsertInvoices(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'invoices',
        runStartedAt
      )
    })
  }

  async syncCharges(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing charges')

    return this.withSyncRun('charges', 'syncCharges', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.ChargeListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.charges.list({ ...params, ...pagination }),
        (items) => this.upsertCharges(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'charges',
        runStartedAt
      )
    })
  }

  async syncSetupIntents(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing setup_intents')

    return this.withSyncRun('setup_intents', 'syncSetupIntents', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.SetupIntentListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.setupIntents.list({ ...params, ...pagination }),
        (items) => this.upsertSetupIntents(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'setup_intents',
        runStartedAt
      )
    })
  }

  async syncPaymentIntents(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing payment_intents')

    return this.withSyncRun(
      'payment_intents',
      'syncPaymentIntents',
      async (cursor, runStartedAt) => {
        const accountId = await this.getAccountId()
        const params: Stripe.PaymentIntentListParams = { limit: 100 }

        if (syncParams?.created) {
          params.created = syncParams.created
        } else if (cursor) {
          params.created = { gte: cursor }
          this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
        }

        return this.fetchAndUpsert(
          (pagination) => this.stripe.paymentIntents.list({ ...params, ...pagination }),
          (items) =>
            this.upsertPaymentIntents(items, accountId, syncParams?.backfillRelatedEntities),
          accountId,
          'payment_intents',
          runStartedAt
        )
      }
    )
  }

  async syncTaxIds(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing tax_ids')

    return this.withSyncRun('tax_ids', 'syncTaxIds', async (_cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.TaxIdListParams = { limit: 100 }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.taxIds.list({ ...params, ...pagination }),
        (items) => this.upsertTaxIds(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'tax_ids',
        runStartedAt
      )
    })
  }

  async syncPaymentMethods(syncParams?: SyncParams): Promise<Sync> {
    // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
    // Thus, we need to loop through all customers
    this.config.logger?.info('Syncing payment method')

    return this.withSyncRun(
      'payment_methods',
      'syncPaymentMethods',
      async (_cursor, runStartedAt) => {
        const accountId = await this.getAccountId()

        // deleted is a generated column that may be NULL for non-deleted customers
        // Use COALESCE to treat NULL as false, or use IS NOT TRUE to include NULL and false
        const prepared = sql(
          `select id from "stripe"."customers" WHERE COALESCE(deleted, false) <> true;`
        )([])

        const customerIds = await this.postgresClient
          .query(prepared.text, prepared.values)
          .then(({ rows }) => rows.map((it) => it.id))

        this.config.logger?.info(`Getting payment methods for ${customerIds.length} customers`)

        let synced = 0

        // Process customers in parallel chunks (configurable concurrency)
        const chunkSize = this.config.maxConcurrentCustomers ?? 3
        for (const customerIdChunk of chunkArray(customerIds, chunkSize)) {
          await Promise.all(
            customerIdChunk.map(async (customerId) => {
              const CHECKPOINT_SIZE = 100
              let currentBatch: Stripe.PaymentMethod[] = []

              // Manual pagination - each fetch() gets automatic retry protection
              let hasMore = true
              let startingAfter: string | undefined = undefined

              while (hasMore) {
                const response: Stripe.ApiList<Stripe.PaymentMethod> =
                  await this.stripe.paymentMethods.list({
                    limit: 100,
                    customer: customerId,
                    ...(startingAfter ? { starting_after: startingAfter } : {}),
                  })

                for (const item of response.data) {
                  currentBatch.push(item)
                  if (currentBatch.length >= CHECKPOINT_SIZE) {
                    await this.upsertPaymentMethods(
                      currentBatch,
                      accountId,
                      syncParams?.backfillRelatedEntities
                    )
                    synced += currentBatch.length
                    await this.postgresClient.incrementObjectProgress(
                      accountId,
                      runStartedAt,
                      'payment_methods',
                      currentBatch.length
                    )
                    currentBatch = []
                  }
                }

                hasMore = response.has_more
                if (response.data.length > 0) {
                  startingAfter = response.data[response.data.length - 1].id
                }
              }

              // Process remaining items
              if (currentBatch.length > 0) {
                await this.upsertPaymentMethods(
                  currentBatch,
                  accountId,
                  syncParams?.backfillRelatedEntities
                )
                synced += currentBatch.length
                await this.postgresClient.incrementObjectProgress(
                  accountId,
                  runStartedAt,
                  'payment_methods',
                  currentBatch.length
                )
              }
            })
          )
        }

        // Mark object sync as complete (run completion handled by withSyncRun)
        await this.postgresClient.completeObjectSync(accountId, runStartedAt, 'payment_methods')

        return { synced }
      }
    )
  }

  async syncDisputes(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing disputes')

    return this.withSyncRun('disputes', 'syncDisputes', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.DisputeListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.disputes.list({ ...params, ...pagination }),
        (items) => this.upsertDisputes(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'disputes',
        runStartedAt
      )
    })
  }

  async syncEarlyFraudWarnings(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing early fraud warnings')

    return this.withSyncRun(
      'early_fraud_warnings',
      'syncEarlyFraudWarnings',
      async (cursor, runStartedAt) => {
        const accountId = await this.getAccountId()
        const params: Stripe.Radar.EarlyFraudWarningListParams = { limit: 100 }

        if (syncParams?.created) {
          params.created = syncParams.created
        } else if (cursor) {
          params.created = { gte: cursor }
          this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
        }

        return this.fetchAndUpsert(
          (pagination) => this.stripe.radar.earlyFraudWarnings.list({ ...params, ...pagination }),
          (items) =>
            this.upsertEarlyFraudWarning(items, accountId, syncParams?.backfillRelatedEntities),
          accountId,
          'early_fraud_warnings',
          runStartedAt
        )
      }
    )
  }

  async syncRefunds(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing refunds')

    return this.withSyncRun('refunds', 'syncRefunds', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.RefundListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.refunds.list({ ...params, ...pagination }),
        (items) => this.upsertRefunds(items, accountId, syncParams?.backfillRelatedEntities),
        accountId,
        'refunds',
        runStartedAt
      )
    })
  }

  async syncCreditNotes(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing credit notes')

    return this.withSyncRun('credit_notes', 'syncCreditNotes', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.CreditNoteListParams = { limit: 100 }

      if (syncParams?.created) {
        params.created = syncParams.created
      } else if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }

      return this.fetchAndUpsert(
        (pagination) => this.stripe.creditNotes.list({ ...params, ...pagination }),
        (creditNotes) => this.upsertCreditNotes(creditNotes, accountId),
        accountId,
        'credit_notes',
        runStartedAt
      )
    })
  }

  async syncFeatures(syncParams?: SyncFeaturesParams): Promise<Sync> {
    this.config.logger?.info('Syncing features')

    return this.withSyncRun('features', 'syncFeatures', async (cursor, runStartedAt) => {
      const accountId = await this.getAccountId()
      const params: Stripe.Entitlements.FeatureListParams = {
        limit: 100,
        ...syncParams?.pagination,
      }
      return this.fetchAndUpsert(
        () => this.stripe.entitlements.features.list(params),
        (features) => this.upsertFeatures(features, accountId),
        accountId,
        'features',
        runStartedAt
      )
    })
  }

  async syncEntitlements(customerId: string, syncParams?: SyncEntitlementsParams): Promise<Sync> {
    this.config.logger?.info('Syncing entitlements')

    return this.withSyncRun(
      'active_entitlements',
      'syncEntitlements',
      async (cursor, runStartedAt) => {
        const accountId = await this.getAccountId()
        const params: Stripe.Entitlements.ActiveEntitlementListParams = {
          customer: customerId,
          limit: 100,
          ...syncParams?.pagination,
        }
        return this.fetchAndUpsert(
          () => this.stripe.entitlements.activeEntitlements.list(params),
          (entitlements) => this.upsertActiveEntitlements(customerId, entitlements, accountId),
          accountId,
          'active_entitlements',
          runStartedAt
        )
      }
    )
  }

  async syncCheckoutSessions(syncParams?: SyncParams): Promise<Sync> {
    this.config.logger?.info('Syncing checkout sessions')

    return this.withSyncRun(
      'checkout_sessions',
      'syncCheckoutSessions',
      async (cursor, runStartedAt) => {
        const accountId = await this.getAccountId()
        const params: Stripe.Checkout.SessionListParams = { limit: 100 }

        if (syncParams?.created) {
          params.created = syncParams.created
        } else if (cursor) {
          params.created = { gte: cursor }
          this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
        }

        return this.fetchAndUpsert(
          (pagination) => this.stripe.checkout.sessions.list({ ...params, ...pagination }),
          (items) =>
            this.upsertCheckoutSessions(items, accountId, syncParams?.backfillRelatedEntities),
          accountId,
          'checkout_sessions',
          runStartedAt
        )
      }
    )
  }

  /**
   * Helper to wrap a sync operation in the observable sync system.
   * Creates/gets a sync run, sets up the object run, gets cursor, and handles completion.
   *
   * @param resourceName - The resource being synced (e.g., 'products', 'customers')
   * @param triggeredBy - What triggered this sync (for observability)
   * @param fn - The sync function to execute, receives cursor and runStartedAt
   * @returns The result of the sync function
   */
  private async withSyncRun<T>(
    resourceName: string,
    triggeredBy: string,
    fn: (cursor: number | null, runStartedAt: Date) => Promise<T>
  ): Promise<T> {
    const accountId = await this.getAccountId()

    // Get cursor from LAST COMPLETED sync (for incremental sync)
    const lastCursor = await this.postgresClient.getLastCompletedCursor(accountId, resourceName)
    const cursor = lastCursor ? parseInt(lastCursor) : null

    // Get or create sync run
    const runKey = await this.postgresClient.getOrCreateSyncRun(accountId, triggeredBy)
    if (!runKey) {
      // Race condition - get active run
      const activeRun = await this.postgresClient.getActiveSyncRun(accountId)
      if (!activeRun) {
        throw new Error('Failed to get or create sync run')
      }
      throw new Error('Another sync is already running for this account')
    }

    const { runStartedAt } = runKey

    // Create and start object run
    await this.postgresClient.createObjectRuns(accountId, runStartedAt, [resourceName])
    await this.postgresClient.tryStartObjectSync(accountId, runStartedAt, resourceName)

    try {
      const result = await fn(cursor, runStartedAt)

      // Complete the sync run
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)

      return result
    } catch (error) {
      // Fail the sync run
      await this.postgresClient.failObjectSync(
        accountId,
        runStartedAt,
        resourceName,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error
    }
  }

  private async fetchAndUpsert<T extends { id?: string }>(
    fetch: (params?: { starting_after?: string }) => Promise<Stripe.ApiList<T>>,
    upsert: (items: T[], accountId: string) => Promise<T[]>,
    accountId: string,
    resourceName: string,
    runStartedAt: Date
  ): Promise<Sync> {
    const CHECKPOINT_SIZE = 100 // Match Stripe page size
    let totalSynced = 0
    let currentBatch: T[] = []

    try {
      this.config.logger?.info('Fetching items to sync from Stripe')

      try {
        let hasMore = true
        let startingAfter: string | undefined = undefined

        // Manual pagination loop - each fetch() call gets automatic retry protection
        while (hasMore) {
          const response = await fetch(
            startingAfter ? { starting_after: startingAfter } : undefined
          )

          for (const item of response.data) {
            currentBatch.push(item)

            // Checkpoint every 100 items (1 Stripe page)
            if (currentBatch.length >= CHECKPOINT_SIZE) {
              this.config.logger?.info(`Upserting batch of ${currentBatch.length} items`)
              await upsert(currentBatch, accountId)
              totalSynced += currentBatch.length

              // Update progress and cursor with max created from this batch
              await this.postgresClient.incrementObjectProgress(
                accountId,
                runStartedAt,
                resourceName,
                currentBatch.length
              )
              const maxCreated = Math.max(
                ...currentBatch.map((i) => (i as { created?: number }).created || 0)
              )
              if (maxCreated > 0) {
                await this.postgresClient.updateObjectCursor(
                  accountId,
                  runStartedAt,
                  resourceName,
                  String(maxCreated)
                )
                this.config.logger?.info(`Checkpoint: cursor updated to ${maxCreated}`)
              }

              currentBatch = []
            }
          }

          hasMore = response.has_more
          if (response.data.length > 0) {
            startingAfter = response.data[response.data.length - 1].id
          }
        }

        // Process remaining items
        if (currentBatch.length > 0) {
          this.config.logger?.info(`Upserting final batch of ${currentBatch.length} items`)
          await upsert(currentBatch, accountId)
          totalSynced += currentBatch.length

          await this.postgresClient.incrementObjectProgress(
            accountId,
            runStartedAt,
            resourceName,
            currentBatch.length
          )
          const maxCreated = Math.max(
            ...currentBatch.map((i) => (i as { created?: number }).created || 0)
          )
          if (maxCreated > 0) {
            await this.postgresClient.updateObjectCursor(
              accountId,
              runStartedAt,
              resourceName,
              String(maxCreated)
            )
          }
        }
      } catch (error) {
        // Save partial progress before re-throwing
        if (currentBatch.length > 0) {
          this.config.logger?.info(
            `Error occurred, saving partial progress: ${currentBatch.length} items`
          )
          await upsert(currentBatch, accountId)
          totalSynced += currentBatch.length

          await this.postgresClient.incrementObjectProgress(
            accountId,
            runStartedAt,
            resourceName,
            currentBatch.length
          )
          const maxCreated = Math.max(
            ...currentBatch.map((i) => (i as { created?: number }).created || 0)
          )
          if (maxCreated > 0) {
            await this.postgresClient.updateObjectCursor(
              accountId,
              runStartedAt,
              resourceName,
              String(maxCreated)
            )
          }
        }
        throw error
      }

      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)

      this.config.logger?.info(`Sync complete: ${totalSynced} items synced`)
      return { synced: totalSynced }
    } catch (error) {
      await this.postgresClient.failObjectSync(
        accountId,
        runStartedAt,
        resourceName,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error
    }
  }

  private async upsertCharges(
    charges: Stripe.Charge[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Charge[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(charges, 'customer'), accountId),
        this.backfillInvoices(getUniqueIds(charges, 'invoice'), accountId),
      ])
    }

    await this.expandEntity(charges, 'refunds', (id) =>
      this.stripe.refunds.list({ charge: id, limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      charges,
      'charges',
      accountId,
      syncTimestamp
    )
  }

  private async backfillCharges(chargeIds: string[], accountId: string) {
    const missingChargeIds = await this.postgresClient.findMissingEntries('charges', chargeIds)

    await this.fetchMissingEntities(missingChargeIds, (id) =>
      this.stripe.charges.retrieve(id)
    ).then((charges) => this.upsertCharges(charges, accountId))
  }

  private async backfillPaymentIntents(paymentIntentIds: string[], accountId: string) {
    const missingIds = await this.postgresClient.findMissingEntries(
      'payment_intents',
      paymentIntentIds
    )

    await this.fetchMissingEntities(missingIds, (id) =>
      this.stripe.paymentIntents.retrieve(id)
    ).then((paymentIntents) => this.upsertPaymentIntents(paymentIntents, accountId))
  }

  private async upsertCreditNotes(
    creditNotes: Stripe.CreditNote[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.CreditNote[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(creditNotes, 'customer'), accountId),
        this.backfillInvoices(getUniqueIds(creditNotes, 'invoice'), accountId),
      ])
    }

    await this.expandEntity(creditNotes, 'lines', (id) =>
      this.stripe.creditNotes.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      creditNotes,
      'credit_notes',
      accountId,
      syncTimestamp
    )
  }

  async upsertCheckoutSessions(
    checkoutSessions: Stripe.Checkout.Session[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Checkout.Session[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(checkoutSessions, 'customer'), accountId),
        this.backfillSubscriptions(getUniqueIds(checkoutSessions, 'subscription'), accountId),
        this.backfillPaymentIntents(getUniqueIds(checkoutSessions, 'payment_intent'), accountId),
        this.backfillInvoices(getUniqueIds(checkoutSessions, 'invoice'), accountId),
      ])
    }

    // Upsert checkout sessions first
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      checkoutSessions,
      'checkout_sessions',
      accountId,
      syncTimestamp
    )

    await this.fillCheckoutSessionsLineItems(
      checkoutSessions.map((cs) => cs.id),
      accountId,
      syncTimestamp
    )

    return rows
  }

  async upsertEarlyFraudWarning(
    earlyFraudWarnings: Stripe.Radar.EarlyFraudWarning[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Radar.EarlyFraudWarning[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(earlyFraudWarnings, 'payment_intent'), accountId),
        this.backfillCharges(getUniqueIds(earlyFraudWarnings, 'charge'), accountId),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      earlyFraudWarnings,
      'early_fraud_warnings',
      accountId,
      syncTimestamp
    )
  }

  async upsertRefunds(
    refunds: Stripe.Refund[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Refund[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(refunds, 'payment_intent'), accountId),
        this.backfillCharges(getUniqueIds(refunds, 'charge'), accountId),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      refunds,
      'refunds',
      accountId,
      syncTimestamp
    )
  }

  async upsertReviews(
    reviews: Stripe.Review[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Review[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(reviews, 'payment_intent'), accountId),
        this.backfillCharges(getUniqueIds(reviews, 'charge'), accountId),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      reviews,
      'reviews',
      accountId,
      syncTimestamp
    )
  }

  async upsertCustomers(
    customers: (Stripe.Customer | Stripe.DeletedCustomer)[],
    accountId: string,
    syncTimestamp?: string
  ): Promise<(Stripe.Customer | Stripe.DeletedCustomer)[]> {
    const deletedCustomers = customers.filter((customer) => customer.deleted)
    const nonDeletedCustomers = customers.filter((customer) => !customer.deleted)

    await this.postgresClient.upsertManyWithTimestampProtection(
      nonDeletedCustomers,
      'customers',
      accountId,
      syncTimestamp
    )
    await this.postgresClient.upsertManyWithTimestampProtection(
      deletedCustomers,
      'customers',
      accountId,
      syncTimestamp
    )

    return customers
  }

  async backfillCustomers(customerIds: string[], accountId: string) {
    const missingIds = await this.postgresClient.findMissingEntries('customers', customerIds)

    await this.fetchMissingEntities(missingIds, (id) => this.stripe.customers.retrieve(id))
      .then((entries) => this.upsertCustomers(entries, accountId))
      .catch((err) => {
        this.config.logger?.error(err, 'Failed to backfill')
        throw err
      })
  }

  async upsertDisputes(
    disputes: Stripe.Dispute[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Dispute[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCharges(getUniqueIds(disputes, 'charge'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      disputes,
      'disputes',
      accountId,
      syncTimestamp
    )
  }

  async upsertInvoices(
    invoices: Stripe.Invoice[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Invoice[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(invoices, 'customer'), accountId),
        this.backfillSubscriptions(getUniqueIds(invoices, 'subscription'), accountId),
      ])
    }

    await this.expandEntity(invoices, 'lines', (id) =>
      this.stripe.invoices.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      invoices,
      'invoices',
      accountId,
      syncTimestamp
    )
  }

  backfillInvoices = async (invoiceIds: string[], accountId: string) => {
    const missingIds = await this.postgresClient.findMissingEntries('invoices', invoiceIds)
    await this.fetchMissingEntities(missingIds, (id) => this.stripe.invoices.retrieve(id)).then(
      (entries) => this.upsertInvoices(entries, accountId)
    )
  }

  backfillPrices = async (priceIds: string[], accountId: string) => {
    const missingIds = await this.postgresClient.findMissingEntries('prices', priceIds)
    await this.fetchMissingEntities(missingIds, (id) => this.stripe.prices.retrieve(id)).then(
      (entries) => this.upsertPrices(entries, accountId)
    )
  }

  async upsertPlans(
    plans: Stripe.Plan[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Plan[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(plans, 'product'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      plans,
      'plans',
      accountId,
      syncTimestamp
    )
  }

  async deletePlan(id: string): Promise<boolean> {
    return this.postgresClient.delete('plans', id)
  }

  async upsertPrices(
    prices: Stripe.Price[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Price[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(prices, 'product'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      prices,
      'prices',
      accountId,
      syncTimestamp
    )
  }

  async deletePrice(id: string): Promise<boolean> {
    return this.postgresClient.delete('prices', id)
  }

  async upsertProducts(
    products: Stripe.Product[],
    accountId: string,
    syncTimestamp?: string
  ): Promise<Stripe.Product[]> {
    return this.postgresClient.upsertManyWithTimestampProtection(
      products,
      'products',
      accountId,
      syncTimestamp
    )
  }

  async deleteProduct(id: string): Promise<boolean> {
    return this.postgresClient.delete('products', id)
  }

  async backfillProducts(productIds: string[], accountId: string) {
    const missingProductIds = await this.postgresClient.findMissingEntries('products', productIds)

    await this.fetchMissingEntities(missingProductIds, (id) =>
      this.stripe.products.retrieve(id)
    ).then((products) => this.upsertProducts(products, accountId))
  }

  async upsertPaymentIntents(
    paymentIntents: Stripe.PaymentIntent[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.PaymentIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(paymentIntents, 'customer'), accountId),
        this.backfillInvoices(getUniqueIds(paymentIntents, 'invoice'), accountId),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      paymentIntents,
      'payment_intents',
      accountId,
      syncTimestamp
    )
  }

  async upsertPaymentMethods(
    paymentMethods: Stripe.PaymentMethod[],
    accountId: string,
    backfillRelatedEntities: boolean = false,
    syncTimestamp?: string
  ): Promise<Stripe.PaymentMethod[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(paymentMethods, 'customer'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      paymentMethods,
      'payment_methods',
      accountId,
      syncTimestamp
    )
  }

  async upsertSetupIntents(
    setupIntents: Stripe.SetupIntent[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.SetupIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(setupIntents, 'customer'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      setupIntents,
      'setup_intents',
      accountId,
      syncTimestamp
    )
  }

  async upsertTaxIds(
    taxIds: Stripe.TaxId[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.TaxId[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(taxIds, 'customer'), accountId)
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      taxIds,
      'tax_ids',
      accountId,
      syncTimestamp
    )
  }

  async deleteTaxId(id: string): Promise<boolean> {
    return this.postgresClient.delete('tax_ids', id)
  }

  async upsertSubscriptionItems(
    subscriptionItems: Stripe.SubscriptionItem[],
    accountId: string,
    syncTimestamp?: string
  ) {
    const modifiedSubscriptionItems = subscriptionItems.map((subscriptionItem) => {
      // Modify price object to string id; reference prices table
      const priceId = subscriptionItem.price.id.toString()
      // deleted exists only on a deleted item
      const deleted = subscriptionItem.deleted
      // quantity not exist on volume tier item
      const quantity = subscriptionItem.quantity
      return {
        ...subscriptionItem,
        price: priceId,
        deleted: deleted ?? false,
        quantity: quantity ?? null,
      }
    })

    await this.postgresClient.upsertManyWithTimestampProtection(
      modifiedSubscriptionItems,
      'subscription_items',
      accountId,
      syncTimestamp
    )
  }

  async fillCheckoutSessionsLineItems(
    checkoutSessionIds: string[],
    accountId: string,
    syncTimestamp?: string
  ) {
    for (const checkoutSessionId of checkoutSessionIds) {
      const lineItemResponses: Stripe.LineItem[] = []

      // Manual pagination - each fetch() gets automatic retry protection
      let hasMore = true
      let startingAfter: string | undefined = undefined

      while (hasMore) {
        const response: Stripe.ApiList<Stripe.LineItem> =
          await this.stripe.checkout.sessions.listLineItems(checkoutSessionId, {
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          })

        lineItemResponses.push(...response.data)

        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
      }

      await this.upsertCheckoutSessionLineItems(
        lineItemResponses,
        checkoutSessionId,
        accountId,
        syncTimestamp
      )
    }
  }

  async upsertCheckoutSessionLineItems(
    lineItems: Stripe.LineItem[],
    checkoutSessionId: string,
    accountId: string,
    syncTimestamp?: string
  ) {
    // prices are needed for line items relation
    await this.backfillPrices(
      lineItems
        .map((lineItem) => lineItem.price?.id?.toString() ?? undefined)
        .filter((id) => id !== undefined),
      accountId
    )

    const modifiedLineItems = lineItems.map((lineItem) => {
      // Extract price ID if price is an object, otherwise use the string value
      const priceId =
        typeof lineItem.price === 'object' && lineItem.price?.id
          ? lineItem.price.id.toString()
          : lineItem.price?.toString() || null

      return {
        ...lineItem,
        price: priceId,
        checkout_session: checkoutSessionId,
      }
    })

    await this.postgresClient.upsertManyWithTimestampProtection(
      modifiedLineItems,
      'checkout_session_line_items',
      accountId,
      syncTimestamp
    )
  }

  async markDeletedSubscriptionItems(
    subscriptionId: string,
    currentSubItemIds: string[]
  ): Promise<{ rowCount: number }> {
    // deleted is a generated column that may be NULL for non-deleted items
    let prepared = sql(`
    select id from "stripe"."subscription_items"
    where subscription = :subscriptionId and COALESCE(deleted, false) = false;
    `)({ subscriptionId })
    const { rows } = await this.postgresClient.query(prepared.text, prepared.values)
    const deletedIds = rows.filter(
      ({ id }: { id: string }) => currentSubItemIds.includes(id) === false
    )

    if (deletedIds.length > 0) {
      const ids = deletedIds.map(({ id }: { id: string }) => id)
      // Since deleted is a generated column, we need to update raw_data instead
      // Use jsonb_set to set the deleted field to true in the raw_data JSON
      prepared = sql(`
      update "stripe"."subscription_items"
      set _raw_data = jsonb_set(_raw_data, '{deleted}', 'true'::jsonb)
      where id=any(:ids::text[]);
      `)({ ids })
      const { rowCount } = await this.postgresClient.query(prepared.text, prepared.values)
      return { rowCount: rowCount || 0 }
    } else {
      return { rowCount: 0 }
    }
  }

  async upsertSubscriptionSchedules(
    subscriptionSchedules: Stripe.SubscriptionSchedule[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.SubscriptionSchedule[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptionSchedules, 'customer')

      await this.backfillCustomers(customerIds, accountId)
    }

    // Run it
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      subscriptionSchedules,
      'subscription_schedules',
      accountId,
      syncTimestamp
    )

    return rows
  }

  async upsertSubscriptions(
    subscriptions: Stripe.Subscription[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Subscription[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptions, 'customer')

      await this.backfillCustomers(customerIds, accountId)
    }

    await this.expandEntity(subscriptions, 'items', (id) =>
      this.stripe.subscriptionItems.list({ subscription: id, limit: 100 })
    )

    // Run it
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      subscriptions,
      'subscriptions',
      accountId,
      syncTimestamp
    )

    // Upsert subscription items into a separate table
    // need to run after upsert subscription cos subscriptionItems will reference the subscription
    const allSubscriptionItems = subscriptions.flatMap((subscription) => subscription.items.data)
    await this.upsertSubscriptionItems(allSubscriptionItems, accountId, syncTimestamp)

    // We have to mark existing subscription item in db as deleted
    // if it doesn't exist in current subscriptionItems list
    const markSubscriptionItemsDeleted: Promise<{ rowCount: number }>[] = []
    for (const subscription of subscriptions) {
      const subscriptionItems = subscription.items.data
      const subItemIds = subscriptionItems.map((x: Stripe.SubscriptionItem) => x.id)
      markSubscriptionItemsDeleted.push(
        this.markDeletedSubscriptionItems(subscription.id, subItemIds)
      )
    }
    await Promise.all(markSubscriptionItemsDeleted)

    return rows
  }

  async deleteRemovedActiveEntitlements(
    customerId: string,
    currentActiveEntitlementIds: string[]
  ): Promise<{ rowCount: number }> {
    const prepared = sql(`
      delete from "stripe"."active_entitlements"
      where customer = :customerId and id <> ALL(:currentActiveEntitlementIds::text[]);
      `)({ customerId, currentActiveEntitlementIds })
    const { rowCount } = await this.postgresClient.query(prepared.text, prepared.values)
    return { rowCount: rowCount || 0 }
  }

  async upsertFeatures(
    features: Stripe.Entitlements.Feature[],
    accountId: string,
    syncTimestamp?: string
  ) {
    return this.postgresClient.upsertManyWithTimestampProtection(
      features,
      'features',
      accountId,
      syncTimestamp
    )
  }

  async backfillFeatures(featureIds: string[], accountId: string) {
    const missingFeatureIds = await this.postgresClient.findMissingEntries('features', featureIds)
    await this.fetchMissingEntities(missingFeatureIds, (id) =>
      this.stripe.entitlements.features.retrieve(id)
    )
      .then((features) => this.upsertFeatures(features, accountId))
      .catch((err) => {
        this.config.logger?.error(err, 'Failed to backfill features')
        throw err
      })
  }

  async upsertActiveEntitlements(
    customerId: string,
    activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(activeEntitlements, 'customer'), accountId),
        this.backfillFeatures(getUniqueIds(activeEntitlements, 'feature'), accountId),
      ])
    }

    const entitlements = activeEntitlements.map((entitlement) => ({
      id: entitlement.id,
      object: entitlement.object,
      feature:
        typeof entitlement.feature === 'string' ? entitlement.feature : entitlement.feature.id,
      customer: customerId,
      livemode: entitlement.livemode,
      lookup_key: entitlement.lookup_key,
    }))

    return this.postgresClient.upsertManyWithTimestampProtection(
      entitlements,
      'active_entitlements',
      accountId,
      syncTimestamp
    )
  }

  async findOrCreateManagedWebhook(
    url: string,
    params?: Omit<Stripe.WebhookEndpointCreateParams, 'url'>
  ): Promise<Stripe.WebhookEndpoint> {
    // Default to supported event types if not specified
    const webhookParams = {
      enabled_events: this.getSupportedEventTypes(),
      ...params,
    }
    // Use advisory lock to prevent race conditions when multiple instances
    // try to create webhooks for the same URL simultaneously
    // Lock is acquired at beginning and released at end via withAdvisoryLock wrapper
    const accountId = await this.getAccountId()
    // A webhook should be guaranteed unique over account id and url
    const lockKey = `webhook:${accountId}:${url}`

    return this.postgresClient.withAdvisoryLock(lockKey, async () => {
      // Step 1: Check if we already have a webhook for this URL (and account ID) in the database
      const existingWebhook = await this.getManagedWebhookByUrl(url)

      if (existingWebhook) {
        // Verify it still exists and is valid in Stripe
        try {
          const stripeWebhook = await this.stripe.webhookEndpoints.retrieve(existingWebhook.id)
          if (stripeWebhook.status === 'enabled') {
            // Webhook is valid, reuse it
            return stripeWebhook
          }
          // Webhook is disabled, delete it and we'll create a new one below
          this.config.logger?.info(
            { webhookId: existingWebhook.id },
            'Webhook is disabled, deleting and will recreate'
          )
          await this.stripe.webhookEndpoints.del(existingWebhook.id)
          await this.postgresClient.delete('_managed_webhooks', existingWebhook.id)
        } catch (error) {
          // Only delete from database if it's a 404 (webhook deleted in Stripe)
          // Other errors (network issues, rate limits, etc.) should not remove from DB
          const stripeError = error as { statusCode?: number; code?: string }
          if (stripeError?.statusCode === 404 || stripeError?.code === 'resource_missing') {
            this.config.logger?.warn(
              { error, webhookId: existingWebhook.id },
              'Webhook not found in Stripe (404), removing from database'
            )
            await this.postgresClient.delete('_managed_webhooks', existingWebhook.id)
          } else {
            // For other errors, log but don't delete - could be transient
            this.config.logger?.error(
              { error, webhookId: existingWebhook.id },
              'Error retrieving webhook from Stripe, keeping in database'
            )
            // Re-throw to prevent continuing with potentially invalid state
            throw error
          }
        }
      }

      // Step 2: Clean up old webhooks with different URLs
      const allDbWebhooks = await this.listManagedWebhooks()
      for (const dbWebhook of allDbWebhooks) {
        if (dbWebhook.url !== url) {
          this.config.logger?.info(
            { webhookId: dbWebhook.id, oldUrl: dbWebhook.url, newUrl: url },
            'Webhook URL mismatch, deleting'
          )
          try {
            await this.stripe.webhookEndpoints.del(dbWebhook.id)
          } catch (error) {
            this.config.logger?.warn(
              { error, webhookId: dbWebhook.id },
              'Failed to delete old webhook from Stripe'
            )
          }
          await this.postgresClient.delete('_managed_webhooks', dbWebhook.id)
        }
      }

      // Step 3: Before creating a new webhook, check Stripe for orphaned managed webhooks
      // (webhooks that exist in Stripe but not in our database)
      // We identify managed webhooks by checking metadata (preferred) or description (backwards compatible)
      try {
        const stripeWebhooks = await this.stripe.webhookEndpoints.list({ limit: 100 })

        for (const stripeWebhook of stripeWebhooks.data) {
          // Check if this webhook was created by us
          // Method 1 (preferred): Check metadata for managed_by field
          const isManagedByMetadata =
            stripeWebhook.metadata?.managed_by?.toLowerCase().replace(/[\s\-]+/g, '') ===
            'stripesync'

          // Method 2 (backwards compatible): Check if description includes 'stripesync' (spaces/hyphens removed)
          const normalizedDescription =
            stripeWebhook.description?.toLowerCase().replace(/[\s\-]+/g, '') || ''
          const isManagedByDescription = normalizedDescription.includes('stripesync')

          if (isManagedByMetadata || isManagedByDescription) {
            // Check if this webhook is in our database
            const existsInDb = allDbWebhooks.some((dbWebhook) => dbWebhook.id === stripeWebhook.id)

            if (!existsInDb) {
              // This is an orphaned managed webhook - delete it from Stripe
              // This includes old webhooks with different URLs and any other orphaned managed webhooks
              this.config.logger?.warn(
                { webhookId: stripeWebhook.id, url: stripeWebhook.url },
                'Found orphaned managed webhook in Stripe, deleting'
              )
              await this.stripe.webhookEndpoints.del(stripeWebhook.id)
            }
          }
        }
      } catch (error) {
        // Log error but continue - don't let cleanup failure prevent webhook creation
        this.config.logger?.warn({ error }, 'Failed to check for orphaned webhooks')
      }

      // Step 4: No valid matching webhook found, create a new one
      // Advisory lock ensures only one instance reaches here for this URL
      // Create webhook at the exact URL
      const webhook = await this.stripe.webhookEndpoints.create({
        ...webhookParams,
        url,
        // Always set metadata to identify managed webhooks
        metadata: {
          ...webhookParams.metadata,
          managed_by: 'stripe-sync',
          version: pkg.version,
        },
      })

      // Store webhook in database
      const accountId = await this.getAccountId()
      await this.upsertManagedWebhooks([webhook], accountId)

      return webhook
    })
  }

  async getManagedWebhook(id: string): Promise<Stripe.WebhookEndpoint | null> {
    const accountId = await this.getAccountId()
    const result = await this.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE id = $1 AND "account_id" = $2`,
      [id, accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  /**
   * Get a managed webhook by URL and account ID.
   * Used for race condition recovery: when createManagedWebhook hits a unique constraint
   * violation (another instance created the webhook), we need to fetch the existing webhook
   * by URL since we only know the URL, not the ID of the webhook that won the race.
   */
  async getManagedWebhookByUrl(url: string): Promise<Stripe.WebhookEndpoint | null> {
    const accountId = await this.getAccountId()
    const result = await this.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE url = $1 AND "account_id" = $2`,
      [url, accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  async listManagedWebhooks(): Promise<Array<Stripe.WebhookEndpoint>> {
    const accountId = await this.getAccountId()
    const result = await this.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE "account_id" = $1 ORDER BY created DESC`,
      [accountId]
    )
    return result.rows as Array<Stripe.WebhookEndpoint>
  }

  async updateManagedWebhook(
    id: string,
    params: Stripe.WebhookEndpointUpdateParams
  ): Promise<Stripe.WebhookEndpoint> {
    const webhook = await this.stripe.webhookEndpoints.update(id, params)
    const accountId = await this.getAccountId()
    await this.upsertManagedWebhooks([webhook], accountId)
    return webhook
  }

  async deleteManagedWebhook(id: string): Promise<boolean> {
    await this.stripe.webhookEndpoints.del(id)
    return this.postgresClient.delete('_managed_webhooks', id)
  }

  async upsertManagedWebhooks(
    webhooks: Array<Stripe.WebhookEndpoint>,
    accountId: string,
    syncTimestamp?: string
  ): Promise<Array<Stripe.WebhookEndpoint>> {
    // Filter webhooks to only include schema-defined properties
    const filteredWebhooks = webhooks.map((webhook) => {
      const filtered: Record<string, unknown> = {}
      for (const prop of managedWebhookSchema.properties) {
        if (prop in webhook) {
          // No mapping needed for metadata tables - columns don't have underscore prefixes
          filtered[prop] = webhook[prop as keyof typeof webhook]
        }
      }
      return filtered
    })

    return this.postgresClient.upsertManyWithTimestampProtection(
      filteredWebhooks as unknown as Array<Stripe.WebhookEndpoint>,
      '_managed_webhooks',
      accountId,
      syncTimestamp
    )
  }

  async backfillSubscriptions(subscriptionIds: string[], accountId: string) {
    const missingSubscriptionIds = await this.postgresClient.findMissingEntries(
      'subscriptions',
      subscriptionIds
    )

    await this.fetchMissingEntities(missingSubscriptionIds, (id) =>
      this.stripe.subscriptions.retrieve(id)
    ).then((subscriptions) => this.upsertSubscriptions(subscriptions, accountId))
  }

  backfillSubscriptionSchedules = async (subscriptionIds: string[], accountId: string) => {
    const missingSubscriptionIds = await this.postgresClient.findMissingEntries(
      'subscription_schedules',
      subscriptionIds
    )

    await this.fetchMissingEntities(missingSubscriptionIds, (id) =>
      this.stripe.subscriptionSchedules.retrieve(id)
    ).then((subscriptionSchedules) =>
      this.upsertSubscriptionSchedules(subscriptionSchedules, accountId)
    )
  }

  /**
   * Stripe only sends the first 10 entries by default, the option will actively fetch all entries.
   * Uses manual pagination - each fetch() gets automatic retry protection.
   */
  private async expandEntity<
    K extends { id?: string },
    P extends keyof T,
    T extends { id?: string } & { [key in P]?: Stripe.ApiList<K> | null },
  >(
    entities: T[],
    property: P,
    listFn: (id: string, params?: { starting_after?: string }) => Promise<Stripe.ApiList<K>>
  ) {
    if (!this.config.autoExpandLists) return

    for (const entity of entities) {
      if (entity[property]?.has_more) {
        const allData: K[] = []

        // Manual pagination - each fetch() gets automatic retry protection
        let hasMore = true
        let startingAfter: string | undefined = undefined

        while (hasMore) {
          const response = await listFn(
            entity.id!,
            startingAfter ? { starting_after: startingAfter } : undefined
          )

          allData.push(...response.data)

          hasMore = response.has_more
          if (response.data.length > 0) {
            startingAfter = response.data[response.data.length - 1].id
          }
        }

        entity[property] = {
          ...entity[property],
          data: allData,
          has_more: false,
        }
      }
    }
  }

  private async fetchMissingEntities<T>(
    ids: string[],
    fetch: (id: string) => Promise<Stripe.Response<T>>
  ): Promise<T[]> {
    if (!ids.length) return []

    const entities: T[] = []

    for (const id of ids) {
      const entity = await fetch(id)
      entities.push(entity)
    }

    return entities
  }

  /**
   * Closes the database connection pool and cleans up resources.
   * Call this when you're done using the StripeSync instance.
   */
  async close(): Promise<void> {
    await this.postgresClient.pool.end()
  }
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize))
  }
  return result
}
