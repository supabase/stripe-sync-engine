import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import { PostgresClient } from './database/postgres'
import {
  StripeSyncConfig,
  Sync,
  SyncBackfill,
  SyncBackfillParams,
  SyncEntitlementsParams,
  SyncFeaturesParams,
  type RevalidateEntity,
} from './types'
import { managedWebhookSchema } from './schemas/managed_webhook'
import { randomUUID } from 'node:crypto'
import { type PoolConfig } from 'pg'
import { withRetry } from './utils/retry'

function getUniqueIds<T>(entries: T[], key: string): string[] {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key as keyof T]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}

const DEFAULT_SCHEMA = 'stripe'

export interface StripeSyncOptions {
  databaseUrl: string
  stripeApiKey: string
  baseUrl: () => string
  webhookPath?: string
  schema?: string
  stripeApiVersion?: string
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
  keepWebhooksOnShutdown?: boolean
}

export interface StripSyncInfo {
  baseUrl: string
  webhookUrl: string
  webhookUuid: string
}

export class StripeSync {
  stripe: Stripe
  postgresClient: PostgresClient
  private cachedAccount: Stripe.Account | null = null

  constructor(private config: StripeSyncConfig) {
    this.stripe = new Stripe(config.stripeSecretKey, {
      // https://github.com/stripe/stripe-node#configuration
      // @ts-ignore
      apiVersion: config.stripeApiVersion,
      appInfo: {
        name: 'Stripe Postgres Sync',
      },
    })

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
      schema: config.schema || DEFAULT_SCHEMA,
      poolConfig,
    })
  }

  /**
   * Get the Stripe account ID. Retrieves from API if not cached, with fallback to config or object's account field.
   */
  async getAccountId(objectAccountId?: string): Promise<string> {
    // If we have a cached account, use it
    if (this.cachedAccount?.id) {
      return this.cachedAccount.id
    }

    // Retrieve from Stripe API to get full account details
    let account: Stripe.Account
    try {
      const accountIdParam = objectAccountId || this.config.stripeAccountId
      account = accountIdParam
        ? await this.stripe.accounts.retrieve(accountIdParam)
        : await this.stripe.accounts.retrieve()
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve account from Stripe API')
      throw new Error('Failed to retrieve Stripe account. Please ensure API key is valid.')
    }

    this.cachedAccount = account

    // Upsert account info to database
    await this.upsertAccount(account)

    return account.id
  }

  /**
   * Upsert Stripe account information to the database
   */
  private async upsertAccount(account: Stripe.Account): Promise<void> {
    try {
      await this.postgresClient.upsertAccount({
        id: account.id,
        raw_data: account,
      })
    } catch (error) {
      this.config.logger?.error(error, 'Failed to upsert account to database')
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to upsert account to database: ${errorMessage}`)
    }
  }

  /**
   * Get the current account being synced
   */
  async getCurrentAccount(): Promise<Stripe.Account | null> {
    if (this.cachedAccount) {
      return this.cachedAccount
    }

    // Populate cache by calling getAccountId
    await this.getAccountId()

    return this.cachedAccount
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

      // If deleting current account, warn about cache invalidation
      if (this.cachedAccount?.id === accountId) {
        warnings.push(
          'Warning: Deleting the current account. Cache will be cleared after deletion.'
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

      // Clear cache if we deleted the current account
      if (this.cachedAccount?.id === accountId) {
        this.cachedAccount = null
      }

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

  async processWebhook(payload: Buffer | string, signature: string | undefined, uuid?: string) {
    let webhookSecret: string

    if (uuid) {
      // Query the webhook secret from the database using the UUID (managed webhook)
      const result = await this.postgresClient.query(
        `SELECT secret FROM "${this.config.schema || DEFAULT_SCHEMA}"."_managed_webhooks" WHERE uuid = $1`,
        [uuid]
      )

      if (result.rows.length === 0) {
        throw new Error(`No managed webhook found with UUID: ${uuid}`)
      }

      webhookSecret = result.rows[0].secret
    } else {
      // Use the webhook secret from config (non-managed webhook)
      if (!this.config.stripeWebhookSecret) {
        throw new Error(
          'No webhook secret provided. Either pass a uuid for managed webhooks or configure stripeWebhookSecret.'
        )
      }
      webhookSecret = this.config.stripeWebhookSecret
    }

    // Verify webhook signature using the secret
    const event = await this.stripe.webhooks.constructEventAsync(payload, signature!, webhookSecret)

    return this.processEvent(event)
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

    switch (event.type) {
      case 'charge.captured':
      case 'charge.expired':
      case 'charge.failed':
      case 'charge.pending':
      case 'charge.refunded':
      case 'charge.succeeded':
      case 'charge.updated': {
        const { entity: charge, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Charge,
          (id) => this.stripe.charges.retrieve(id),
          (charge) => charge.status === 'failed' || charge.status === 'succeeded'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for charge ${charge.id}`
        )

        await this.upsertCharges(
          [charge],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'customer.deleted': {
        const customer: Stripe.DeletedCustomer = {
          id: event.data.object.id,
          object: 'customer',
          deleted: true,
        }

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for customer ${customer.id}`
        )

        await this.upsertCustomers([customer], accountId, this.getSyncTimestamp(event, false))
        break
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.completed':
      case 'checkout.session.expired': {
        const { entity: checkoutSession, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Checkout.Session,
          (id) => this.stripe.checkout.sessions.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for checkout session ${checkoutSession.id}`
        )

        await this.upsertCheckoutSessions(
          [checkoutSession],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'customer.created':
      case 'customer.updated': {
        const { entity: customer, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Customer | Stripe.DeletedCustomer,
          (id) => this.stripe.customers.retrieve(id),
          (customer) => customer.deleted === true
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for customer ${customer.id}`
        )

        await this.upsertCustomers([customer], accountId, this.getSyncTimestamp(event, refetched))
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.deleted': // Soft delete using `status = canceled`
      case 'customer.subscription.paused':
      case 'customer.subscription.pending_update_applied':
      case 'customer.subscription.pending_update_expired':
      case 'customer.subscription.trial_will_end':
      case 'customer.subscription.resumed':
      case 'customer.subscription.updated': {
        const { entity: subscription, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Subscription,
          (id) => this.stripe.subscriptions.retrieve(id),
          (subscription) =>
            subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for subscription ${subscription.id}`
        )

        await this.upsertSubscriptions(
          [subscription],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'customer.tax_id.updated':
      case 'customer.tax_id.created': {
        const { entity: taxId, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.TaxId,
          (id) => this.stripe.taxIds.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for taxId ${taxId.id}`
        )

        await this.upsertTaxIds([taxId], accountId, false, this.getSyncTimestamp(event, refetched))
        break
      }
      case 'customer.tax_id.deleted': {
        const taxId = event.data.object as Stripe.TaxId

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for taxId ${taxId.id}`
        )

        await this.deleteTaxId(taxId.id)
        break
      }
      case 'invoice.created':
      case 'invoice.deleted':
      case 'invoice.finalized':
      case 'invoice.finalization_failed':
      case 'invoice.paid':
      case 'invoice.payment_action_required':
      case 'invoice.payment_failed':
      case 'invoice.payment_succeeded':
      case 'invoice.upcoming':
      case 'invoice.sent':
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
      case 'invoice.updated': {
        const { entity: invoice, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Invoice,
          (id) => this.stripe.invoices.retrieve(id),
          (invoice) => invoice.status === 'void'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for invoice ${invoice.id}`
        )

        await this.upsertInvoices(
          [invoice],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'product.created':
      case 'product.updated': {
        try {
          const { entity: product, refetched } = await this.fetchOrUseWebhookData(
            event.data.object as Stripe.Product,
            (id) => this.stripe.products.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for product ${product.id}`
          )

          await this.upsertProducts([product], accountId, this.getSyncTimestamp(event, refetched))
        } catch (err) {
          if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
            await this.deleteProduct(event.data.object.id)
          } else {
            throw err
          }
        }

        break
      }
      case 'product.deleted': {
        const product = event.data.object as Stripe.Product

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for product ${product.id}`
        )

        await this.deleteProduct(product.id)
        break
      }
      case 'price.created':
      case 'price.updated': {
        try {
          const { entity: price, refetched } = await this.fetchOrUseWebhookData(
            event.data.object as Stripe.Price,
            (id) => this.stripe.prices.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for price ${price.id}`
          )

          await this.upsertPrices(
            [price],
            accountId,
            false,
            this.getSyncTimestamp(event, refetched)
          )
        } catch (err) {
          if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
            await this.deletePrice(event.data.object.id)
          } else {
            throw err
          }
        }

        break
      }
      case 'price.deleted': {
        const price = event.data.object as Stripe.Price

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for price ${price.id}`
        )

        await this.deletePrice(price.id)
        break
      }
      case 'plan.created':
      case 'plan.updated': {
        try {
          const { entity: plan, refetched } = await this.fetchOrUseWebhookData(
            event.data.object as Stripe.Plan,
            (id) => this.stripe.plans.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for plan ${plan.id}`
          )

          await this.upsertPlans([plan], accountId, false, this.getSyncTimestamp(event, refetched))
        } catch (err) {
          if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
            await this.deletePlan(event.data.object.id)
          } else {
            throw err
          }
        }

        break
      }
      case 'plan.deleted': {
        const plan = event.data.object as Stripe.Plan

        this.config.logger?.info(`Received webhook ${event.id}: ${event.type} for plan ${plan.id}`)

        await this.deletePlan(plan.id)
        break
      }
      case 'setup_intent.canceled':
      case 'setup_intent.created':
      case 'setup_intent.requires_action':
      case 'setup_intent.setup_failed':
      case 'setup_intent.succeeded': {
        const { entity: setupIntent, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.SetupIntent,
          (id) => this.stripe.setupIntents.retrieve(id),
          (setupIntent) => setupIntent.status === 'canceled' || setupIntent.status === 'succeeded'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for setupIntent ${setupIntent.id}`
        )

        await this.upsertSetupIntents(
          [setupIntent],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'subscription_schedule.aborted':
      case 'subscription_schedule.canceled':
      case 'subscription_schedule.completed':
      case 'subscription_schedule.created':
      case 'subscription_schedule.expiring':
      case 'subscription_schedule.released':
      case 'subscription_schedule.updated': {
        const { entity: subscriptionSchedule, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.SubscriptionSchedule,
          (id) => this.stripe.subscriptionSchedules.retrieve(id),
          (schedule) => schedule.status === 'canceled' || schedule.status === 'completed'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for subscriptionSchedule ${subscriptionSchedule.id}`
        )

        await this.upsertSubscriptionSchedules(
          [subscriptionSchedule],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'payment_method.attached':
      case 'payment_method.automatically_updated':
      case 'payment_method.detached':
      case 'payment_method.updated': {
        const { entity: paymentMethod, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.PaymentMethod,
          (id) => this.stripe.paymentMethods.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for paymentMethod ${paymentMethod.id}`
        )

        await this.upsertPaymentMethods(
          [paymentMethod],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'charge.dispute.created':
      case 'charge.dispute.funds_reinstated':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed': {
        const { entity: dispute, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Dispute,
          (id) => this.stripe.disputes.retrieve(id),
          (dispute) => dispute.status === 'won' || dispute.status === 'lost'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for dispute ${dispute.id}`
        )

        await this.upsertDisputes(
          [dispute],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.canceled':
      case 'payment_intent.created':
      case 'payment_intent.partially_funded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.processing':
      case 'payment_intent.requires_action':
      case 'payment_intent.succeeded': {
        const { entity: paymentIntent, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.PaymentIntent,
          (id) => this.stripe.paymentIntents.retrieve(id),
          // Final states - do not re-fetch from API
          (entity) => entity.status === 'canceled' || entity.status === 'succeeded'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for paymentIntent ${paymentIntent.id}`
        )

        await this.upsertPaymentIntents(
          [paymentIntent],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }

      case 'credit_note.created':
      case 'credit_note.updated':
      case 'credit_note.voided': {
        const { entity: creditNote, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.CreditNote,
          (id) => this.stripe.creditNotes.retrieve(id),
          (creditNote) => creditNote.status === 'void'
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for creditNote ${creditNote.id}`
        )

        await this.upsertCreditNotes(
          [creditNote],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }

      case 'radar.early_fraud_warning.created':
      case 'radar.early_fraud_warning.updated': {
        const { entity: earlyFraudWarning, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Radar.EarlyFraudWarning,
          (id) => this.stripe.radar.earlyFraudWarnings.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for earlyFraudWarning ${earlyFraudWarning.id}`
        )

        await this.upsertEarlyFraudWarning(
          [earlyFraudWarning],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )

        break
      }

      case 'refund.created':
      case 'refund.failed':
      case 'refund.updated':
      case 'charge.refund.updated': {
        const { entity: refund, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Refund,
          (id) => this.stripe.refunds.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for refund ${refund.id}`
        )

        await this.upsertRefunds(
          [refund],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )
        break
      }

      case 'review.closed':
      case 'review.opened': {
        const { entity: review, refetched } = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Review,
          (id) => this.stripe.reviews.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for review ${review.id}`
        )

        await this.upsertReviews(
          [review],
          accountId,
          false,
          this.getSyncTimestamp(event, refetched)
        )

        break
      }
      case 'entitlements.active_entitlement_summary.updated': {
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

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for activeEntitlementSummary for customer ${activeEntitlementSummary.customer}`
        )

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
        break
      }
      default:
        throw new Error('Unhandled webhook event')
    }
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
      // Wrap the fetch call with retry logic for 429 errors
      const fetchedEntity = await withRetry(() => fetchFn(entity.id!), {}, this.config.logger)
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

  async syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
    const { object } = params ?? {}
    let products,
      prices,
      customers,
      checkoutSessions,
      subscriptions,
      subscriptionSchedules,
      invoices,
      setupIntents,
      paymentMethods,
      disputes,
      charges,
      paymentIntents,
      plans,
      taxIds,
      creditNotes,
      earlyFraudWarnings,
      refunds

    // Ensure account exists before syncing (required for _sync_status foreign key)
    await this.getCurrentAccount()

    switch (object) {
      case 'all':
        products = await this.syncProducts(params)
        prices = await this.syncPrices(params)
        plans = await this.syncPlans(params)
        customers = await this.syncCustomers(params)
        subscriptions = await this.syncSubscriptions(params)
        subscriptionSchedules = await this.syncSubscriptionSchedules(params)
        invoices = await this.syncInvoices(params)
        charges = await this.syncCharges(params)
        setupIntents = await this.syncSetupIntents(params)
        paymentMethods = await this.syncPaymentMethods(params)
        paymentIntents = await this.syncPaymentIntents(params)
        taxIds = await this.syncTaxIds(params)
        creditNotes = await this.syncCreditNotes(params)
        disputes = await this.syncDisputes(params)
        earlyFraudWarnings = await this.syncEarlyFraudWarnings(params)
        refunds = await this.syncRefunds(params)
        checkoutSessions = await this.syncCheckoutSessions(params)
        break
      case 'customer':
        customers = await this.syncCustomers(params)
        break
      case 'invoice':
        invoices = await this.syncInvoices(params)
        break
      case 'price':
        prices = await this.syncPrices(params)
        break
      case 'product':
        products = await this.syncProducts(params)
        break
      case 'subscription':
        subscriptions = await this.syncSubscriptions(params)
        break
      case 'subscription_schedules':
        subscriptionSchedules = await this.syncSubscriptionSchedules(params)
        break
      case 'setup_intent':
        setupIntents = await this.syncSetupIntents(params)
        break
      case 'payment_method':
        paymentMethods = await this.syncPaymentMethods(params)
        break
      case 'dispute':
        disputes = await this.syncDisputes(params)
        break
      case 'charge':
        charges = await this.syncCharges(params)
        break
      case 'payment_intent':
        paymentIntents = await this.syncPaymentIntents(params)
      case 'plan':
        plans = await this.syncPlans(params)
        break
      case 'tax_id':
        taxIds = await this.syncTaxIds(params)
        break
      case 'credit_note':
        creditNotes = await this.syncCreditNotes(params)
        break
      case 'early_fraud_warning':
        earlyFraudWarnings = await this.syncEarlyFraudWarnings(params)
        break
      case 'refund':
        refunds = await this.syncRefunds(params)
        break
      case 'checkout_sessions':
        checkoutSessions = await this.syncCheckoutSessions(params)
        break
      default:
        break
    }

    return {
      products,
      prices,
      customers,
      checkoutSessions,
      subscriptions,
      subscriptionSchedules,
      invoices,
      setupIntents,
      paymentMethods,
      disputes,
      charges,
      paymentIntents,
      plans,
      taxIds,
      creditNotes,
      earlyFraudWarnings,
      refunds,
    }
  }

  async syncProducts(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing products')
    const accountId = await this.getAccountId()

    const params: Stripe.ProductListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('products', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.products.list(params),
      (products) => this.upsertProducts(products, accountId),
      accountId,
      'products'
    )
  }

  async syncPrices(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing prices')
    const accountId = await this.getAccountId()

    const params: Stripe.PriceListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('prices', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.prices.list(params),
      (prices) => this.upsertPrices(prices, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'prices'
    )
  }

  async syncPlans(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing plans')
    const accountId = await this.getAccountId()

    const params: Stripe.PlanListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('plans', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.plans.list(params),
      (plans) => this.upsertPlans(plans, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'plans'
    )
  }

  async syncCustomers(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing customers')
    const accountId = await this.getAccountId()

    const params: Stripe.CustomerListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('customers', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.customers.list(params),
      // @ts-expect-error
      (items) => this.upsertCustomers(items, accountId),
      accountId,
      'customers'
    )
  }

  async syncSubscriptions(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscriptions')
    const accountId = await this.getAccountId()

    const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('subscriptions', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.subscriptions.list(params),
      (items) => this.upsertSubscriptions(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'subscriptions'
    )
  }

  async syncSubscriptionSchedules(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscription schedules')
    const accountId = await this.getAccountId()

    const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('subscription_schedules', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.subscriptionSchedules.list(params),
      (items) =>
        this.upsertSubscriptionSchedules(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'subscription_schedules'
    )
  }

  async syncInvoices(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing invoices')
    const accountId = await this.getAccountId()

    const params: Stripe.InvoiceListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('invoices', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.invoices.list(params),
      (items) => this.upsertInvoices(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'invoices'
    )
  }

  async syncCharges(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing charges')
    const accountId = await this.getAccountId()

    const params: Stripe.ChargeListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('charges', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.charges.list(params),
      (items) => this.upsertCharges(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'charges'
    )
  }

  async syncSetupIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing setup_intents')
    const accountId = await this.getAccountId()

    const params: Stripe.SetupIntentListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('setup_intents', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.setupIntents.list(params),
      (items) => this.upsertSetupIntents(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'setup_intents'
    )
  }

  async syncPaymentIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing payment_intents')
    const accountId = await this.getAccountId()

    const params: Stripe.PaymentIntentListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('payment_intents', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.paymentIntents.list(params),
      (items) => this.upsertPaymentIntents(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'payment_intents'
    )
  }

  async syncTaxIds(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing tax_ids')
    const accountId = await this.getAccountId()

    const params: Stripe.TaxIdListParams = { limit: 100 }

    return this.fetchAndUpsert(
      () => this.stripe.taxIds.list(params),
      (items) => this.upsertTaxIds(items, accountId, syncParams?.backfillRelatedEntities),
      accountId
    )
  }

  async syncPaymentMethods(syncParams?: SyncBackfillParams): Promise<Sync> {
    // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
    // Thus, we need to loop through all customers
    this.config.logger?.info('Syncing payment method')
    const accountId = await this.getAccountId()

    // deleted is a generated column that may be NULL for non-deleted customers
    // Use COALESCE to treat NULL as false, or use IS NOT TRUE to include NULL and false
    const prepared = sql(
      `select id from "${this.config.schema}"."customers" WHERE COALESCE(deleted, false) <> true;`
    )([])

    const customerIds = await this.postgresClient
      .query(prepared.text, prepared.values)
      .then(({ rows }) => rows.map((it) => it.id))

    this.config.logger?.info(`Getting payment methods for ${customerIds.length} customers`)

    let synced = 0

    // 10 in parallel as chunks

    for (const customerIdChunk of chunkArray(customerIds, 10)) {
      await Promise.all(
        customerIdChunk.map(async (customerId) => {
          const syncResult = await this.fetchAndUpsert(
            () =>
              this.stripe.paymentMethods.list({
                limit: 100,
                customer: customerId,
              }),
            (items) =>
              this.upsertPaymentMethods(items, accountId, syncParams?.backfillRelatedEntities),
            accountId
          )

          synced += syncResult.synced
        })
      )
    }

    return { synced }
  }

  async syncDisputes(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing disputes')
    const accountId = await this.getAccountId()

    const params: Stripe.DisputeListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('disputes', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.disputes.list(params),
      (items) => this.upsertDisputes(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'disputes'
    )
  }

  async syncEarlyFraudWarnings(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing early fraud warnings')
    const accountId = await this.getAccountId()

    const params: Stripe.Radar.EarlyFraudWarningListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('early_fraud_warnings', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.radar.earlyFraudWarnings.list(params),
      (items) =>
        this.upsertEarlyFraudWarning(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'early_fraud_warnings'
    )
  }

  async syncRefunds(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing refunds')
    const accountId = await this.getAccountId()

    const params: Stripe.RefundListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('refunds', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.refunds.list(params),
      (items) => this.upsertRefunds(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'refunds'
    )
  }

  async syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing credit notes')
    const accountId = await this.getAccountId()

    const params: Stripe.CreditNoteListParams = { limit: 100 }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('credit_notes', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.creditNotes.list(params),
      (creditNotes) => this.upsertCreditNotes(creditNotes, accountId),
      accountId,
      'credit_notes'
    )
  }

  async syncFeatures(syncParams?: SyncFeaturesParams): Promise<Sync> {
    this.config.logger?.info('Syncing features')
    const accountId = await this.getAccountId()
    const params: Stripe.Entitlements.FeatureListParams = { limit: 100, ...syncParams?.pagination }
    return this.fetchAndUpsert(
      () => this.stripe.entitlements.features.list(params),
      (features) => this.upsertFeatures(features, accountId),
      accountId
    )
  }

  async syncEntitlements(customerId: string, syncParams?: SyncEntitlementsParams): Promise<Sync> {
    this.config.logger?.info('Syncing entitlements')
    const accountId = await this.getAccountId()
    const params: Stripe.Entitlements.ActiveEntitlementListParams = {
      customer: customerId,
      limit: 100,
      ...syncParams?.pagination,
    }
    return this.fetchAndUpsert(
      () => this.stripe.entitlements.activeEntitlements.list(params),
      (entitlements) => this.upsertActiveEntitlements(customerId, entitlements, accountId),
      accountId
    )
  }

  async syncCheckoutSessions(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing checkout sessions')
    const accountId = await this.getAccountId()

    const params: Stripe.Checkout.SessionListParams = {
      limit: 100,
    }
    if (syncParams?.created) {
      params.created = syncParams.created
    } else {
      const cursor = await this.postgresClient.getSyncCursor('checkout_sessions', accountId)
      if (cursor) {
        params.created = { gte: cursor }
        this.config.logger?.info(`Incremental sync from cursor: ${cursor}`)
      }
    }

    return this.fetchAndUpsert(
      () => this.stripe.checkout.sessions.list(params),
      (items) => this.upsertCheckoutSessions(items, accountId, syncParams?.backfillRelatedEntities),
      accountId,
      'checkout_sessions'
    )
  }

  private async fetchAndUpsert<T>(
    fetch: () => Stripe.ApiListPromise<T>,
    upsert: (items: T[], accountId: string) => Promise<T[]>,
    accountId: string,
    resourceName?: string
  ): Promise<Sync> {
    const CHECKPOINT_SIZE = 100 // Match Stripe page size
    let totalSynced = 0
    let currentBatch: T[] = []

    if (resourceName) {
      await this.postgresClient.markSyncRunning(resourceName, accountId)
    }

    try {
      this.config.logger?.info('Fetching items to sync from Stripe')

      // Wrap the pagination loop with retry logic for 429 errors
      await withRetry(
        async () => {
          try {
            for await (const item of fetch()) {
              currentBatch.push(item)

              // Checkpoint every 100 items (1 Stripe page)
              if (currentBatch.length >= CHECKPOINT_SIZE) {
                this.config.logger?.info(`Upserting batch of ${currentBatch.length} items`)
                await upsert(currentBatch, accountId)
                totalSynced += currentBatch.length

                // Update cursor with max created from this batch
                if (resourceName) {
                  const maxCreated = Math.max(
                    ...currentBatch.map((i) => (i as { created?: number }).created || 0)
                  )
                  if (maxCreated > 0) {
                    await this.postgresClient.updateSyncCursor(resourceName, accountId, maxCreated)
                    this.config.logger?.info(`Checkpoint: cursor updated to ${maxCreated}`)
                  }
                }

                currentBatch = []
              }
            }

            // Process remaining items
            if (currentBatch.length > 0) {
              this.config.logger?.info(`Upserting final batch of ${currentBatch.length} items`)
              await upsert(currentBatch, accountId)
              totalSynced += currentBatch.length

              if (resourceName) {
                const maxCreated = Math.max(
                  ...currentBatch.map((i) => (i as { created?: number }).created || 0)
                )
                if (maxCreated > 0) {
                  await this.postgresClient.updateSyncCursor(resourceName, accountId, maxCreated)
                }
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

              if (resourceName) {
                const maxCreated = Math.max(
                  ...currentBatch.map((i) => (i as { created?: number }).created || 0)
                )
                if (maxCreated > 0) {
                  await this.postgresClient.updateSyncCursor(resourceName, accountId, maxCreated)
                }
              }
            }
            throw error
          }
        },
        {},
        this.config.logger
      )

      if (resourceName) {
        await this.postgresClient.markSyncComplete(resourceName, accountId)
      }

      this.config.logger?.info(`Sync complete: ${totalSynced} items synced`)
      return { synced: totalSynced }
    } catch (error) {
      if (resourceName) {
        await this.postgresClient.markSyncError(
          resourceName,
          accountId,
          error instanceof Error ? error.message : 'Unknown error'
        )
      }
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

      for await (const lineItem of this.stripe.checkout.sessions.listLineItems(checkoutSessionId, {
        limit: 100,
      })) {
        lineItemResponses.push(lineItem)
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
    select id from "${this.config.schema}"."subscription_items"
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
      update "${this.config.schema}"."subscription_items"
      set raw_data = jsonb_set(raw_data, '{deleted}', 'true'::jsonb)
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
      delete from "${this.config.schema}"."active_entitlements"
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

  // Managed Webhook CRUD methods
  async createManagedWebhook(
    baseUrl: string,
    params: Omit<Stripe.WebhookEndpointCreateParams, 'url'>
  ): Promise<{ webhook: Stripe.WebhookEndpoint; uuid: string }> {
    // Generate UUID for this webhook
    const uuid = randomUUID()

    // Create webhook with UUID in the URL path
    const webhookUrl = `${baseUrl}/${uuid}`
    const webhook = await this.stripe.webhookEndpoints.create({
      ...params,
      url: webhookUrl,
    })

    // Store webhook with UUID in database
    const webhookWithUuid = { ...webhook, uuid }
    const accountId = await this.getAccountId()
    await this.upsertManagedWebhooks([webhookWithUuid], accountId)

    return { webhook, uuid }
  }

  async findOrCreateManagedWebhook(
    baseUrl: string,
    params: Omit<Stripe.WebhookEndpointCreateParams, 'url'>
  ): Promise<{ webhook: Stripe.WebhookEndpoint; uuid: string }> {
    // Query database for existing webhooks
    const existingWebhooks = await this.listManagedWebhooks()

    // Try to find a webhook that matches the base URL
    for (const existingWebhook of existingWebhooks) {
      // Extract base URL from webhook URL (remove /stripe-webhooks/{uuid} suffix)
      const existingBaseUrl = existingWebhook.url.replace(/\/[^/]+$/, '')

      // Check if base URLs match exactly
      if (existingBaseUrl === baseUrl) {
        try {
          // Verify webhook still exists in Stripe and is enabled
          const stripeWebhook = await this.stripe.webhookEndpoints.retrieve(existingWebhook.id)

          if (stripeWebhook.status === 'enabled') {
            // Webhook is valid, reuse it
            return {
              webhook: stripeWebhook,
              uuid: existingWebhook.uuid,
            }
          }
        } catch (error) {
          // Webhook doesn't exist in Stripe anymore, continue searching
          this.config.logger?.warn(
            { error, webhookId: existingWebhook.id },
            'Failed to retrieve existing webhook'
          )
          continue
        }
      }
    }

    // No valid matching webhook found, create a new one
    return this.createManagedWebhook(baseUrl, params)
  }

  async getManagedWebhook(id: string): Promise<(Stripe.WebhookEndpoint & { uuid: string }) | null> {
    const result = await this.postgresClient.query(
      `SELECT * FROM "${this.config.schema || DEFAULT_SCHEMA}"."_managed_webhooks" WHERE id = $1`,
      [id]
    )
    return result.rows.length > 0
      ? (result.rows[0] as Stripe.WebhookEndpoint & { uuid: string })
      : null
  }

  async listManagedWebhooks(): Promise<Array<Stripe.WebhookEndpoint & { uuid: string }>> {
    const result = await this.postgresClient.query(
      `SELECT * FROM "${this.config.schema || DEFAULT_SCHEMA}"."_managed_webhooks" ORDER BY created DESC`
    )
    return result.rows as Array<Stripe.WebhookEndpoint & { uuid: string }>
  }

  async updateManagedWebhook(
    id: string,
    params: Stripe.WebhookEndpointUpdateParams
  ): Promise<Stripe.WebhookEndpoint> {
    const webhook = await this.stripe.webhookEndpoints.update(id, params)
    // Preserve existing UUID when updating
    const existing = await this.getManagedWebhook(id)
    const webhookWithUuid = { ...webhook, uuid: existing?.uuid || randomUUID() }
    const accountId = await this.getAccountId()
    await this.upsertManagedWebhooks([webhookWithUuid], accountId)
    return webhook
  }

  async deleteManagedWebhook(id: string): Promise<boolean> {
    await this.stripe.webhookEndpoints.del(id)
    return this.postgresClient.delete('_managed_webhooks', id)
  }

  async upsertManagedWebhooks(
    webhooks: Array<Stripe.WebhookEndpoint & { uuid: string }>,
    accountId: string,
    syncTimestamp?: string
  ): Promise<Array<Stripe.WebhookEndpoint & { uuid: string }>> {
    // Filter webhooks to only include schema-defined properties
    const filteredWebhooks = webhooks.map((webhook) => {
      const filtered: Record<string, unknown> = {}
      for (const prop of managedWebhookSchema.properties) {
        if (prop in webhook) {
          filtered[prop] = webhook[prop as keyof typeof webhook]
        }
      }
      return filtered
    })

    return this.postgresClient.upsertManyWithTimestampProtection(
      filteredWebhooks as unknown as Array<Stripe.WebhookEndpoint & { uuid: string }>,
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
   */
  private async expandEntity<
    K,
    P extends keyof T,
    T extends { id?: string } & { [key in P]?: Stripe.ApiList<K> | null },
  >(entities: T[], property: P, listFn: (id: string) => Stripe.ApiListPromise<K>) {
    if (!this.config.autoExpandLists) return

    for (const entity of entities) {
      if (entity[property]?.has_more) {
        const allData: K[] = []
        for await (const fetchedEntity of listFn(entity.id!)) {
          allData.push(fetchedEntity)
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
      // Wrap each fetch call with retry logic for 429 errors
      const entity = await withRetry(() => fetch(id), {}, this.config.logger)
      entities.push(entity)
    }

    return entities
  }
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize))
  }
  return result
}
