import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import { PostgresClient } from './database/postgres'
import { chargeSchema } from './schemas/charge'
import { checkoutSessionSchema } from './schemas/checkout_sessions'
import { checkoutSessionLineItemSchema } from './schemas/checkout_session_line_items'
import { creditNoteSchema } from './schemas/credit_note'
import { customerDeletedSchema, customerSchema } from './schemas/customer'
import { disputeSchema } from './schemas/dispute'
import { invoiceSchema } from './schemas/invoice'
import { planSchema } from './schemas/plan'
import { priceSchema } from './schemas/price'
import { productSchema } from './schemas/product'
import { paymentIntentSchema } from './schemas/payment_intent'
import { paymentMethodsSchema } from './schemas/payment_methods'
import { setupIntentsSchema } from './schemas/setup_intents'
import { taxIdSchema } from './schemas/tax_id'
import { subscriptionItemSchema } from './schemas/subscription_item'
import { subscriptionScheduleSchema } from './schemas/subscription_schedules'
import { subscriptionSchema } from './schemas/subscription'
import {
  StripeSyncConfig,
  Sync,
  SyncBackfill,
  SyncBackfillParams,
  SyncEntitlementsParams,
  SyncFeaturesParams,
  type RevalidateEntity,
} from './types'
import { earlyFraudWarningSchema } from './schemas/early_fraud_warning'
import { reviewSchema } from './schemas/review'
import { refundSchema } from './schemas/refund'
import { activeEntitlementSchema } from './schemas/active_entitlement'
import { featureSchema } from './schemas/feature'
import type { PoolConfig } from 'pg'

function getUniqueIds<T>(entries: T[], key: string): string[] {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key as keyof T]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}

const DEFAULT_SCHEMA = 'stripe'

export class StripeSync {
  stripe: Stripe
  postgresClient: PostgresClient

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

  async processWebhook(payload: Buffer | string, signature: string | undefined) {
    const event = await this.stripe.webhooks.constructEventAsync(
      payload,
      signature!,
      this.config.stripeWebhookSecret
    )

    return this.processEvent(event)
  }

  async processEvent(event: Stripe.Event) {
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

        await this.upsertCharges([charge], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertCustomers([customer], this.getSyncTimestamp(event, false))
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

        await this.upsertCustomers([customer], this.getSyncTimestamp(event, refetched))
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

        await this.upsertTaxIds([taxId], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertInvoices([invoice], false, this.getSyncTimestamp(event, refetched))
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

          await this.upsertProducts([product], this.getSyncTimestamp(event, refetched))
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

          await this.upsertPrices([price], false, this.getSyncTimestamp(event, refetched))
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

          await this.upsertPlans([plan], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertSetupIntents([setupIntent], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertDisputes([dispute], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertCreditNotes([creditNote], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertRefunds([refund], false, this.getSyncTimestamp(event, refetched))
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

        await this.upsertReviews([review], false, this.getSyncTimestamp(event, refetched))

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
      const fetchedEntity = await fetchFn(entity.id)
      return { entity: fetchedEntity, refetched: true }
    }

    return { entity, refetched: false }
  }

  async syncSingleEntity(stripeId: string) {
    if (stripeId.startsWith('cus_')) {
      return this.stripe.customers.retrieve(stripeId).then((it) => {
        if (!it || it.deleted) return

        return this.upsertCustomers([it])
      })
    } else if (stripeId.startsWith('in_')) {
      return this.stripe.invoices.retrieve(stripeId).then((it) => this.upsertInvoices([it]))
    } else if (stripeId.startsWith('price_')) {
      return this.stripe.prices.retrieve(stripeId).then((it) => this.upsertPrices([it]))
    } else if (stripeId.startsWith('prod_')) {
      return this.stripe.products.retrieve(stripeId).then((it) => this.upsertProducts([it]))
    } else if (stripeId.startsWith('sub_')) {
      return this.stripe.subscriptions
        .retrieve(stripeId)
        .then((it) => this.upsertSubscriptions([it]))
    } else if (stripeId.startsWith('seti_')) {
      return this.stripe.setupIntents.retrieve(stripeId).then((it) => this.upsertSetupIntents([it]))
    } else if (stripeId.startsWith('pm_')) {
      return this.stripe.paymentMethods
        .retrieve(stripeId)
        .then((it) => this.upsertPaymentMethods([it]))
    } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
      return this.stripe.disputes.retrieve(stripeId).then((it) => this.upsertDisputes([it]))
    } else if (stripeId.startsWith('ch_')) {
      return this.stripe.charges.retrieve(stripeId).then((it) => this.upsertCharges([it], true))
    } else if (stripeId.startsWith('pi_')) {
      return this.stripe.paymentIntents
        .retrieve(stripeId)
        .then((it) => this.upsertPaymentIntents([it]))
    } else if (stripeId.startsWith('txi_')) {
      return this.stripe.taxIds.retrieve(stripeId).then((it) => this.upsertTaxIds([it]))
    } else if (stripeId.startsWith('cn_')) {
      return this.stripe.creditNotes.retrieve(stripeId).then((it) => this.upsertCreditNotes([it]))
    } else if (stripeId.startsWith('issfr_')) {
      return this.stripe.radar.earlyFraudWarnings
        .retrieve(stripeId)
        .then((it) => this.upsertEarlyFraudWarning([it]))
    } else if (stripeId.startsWith('prv_')) {
      return this.stripe.reviews.retrieve(stripeId).then((it) => this.upsertReviews([it]))
    } else if (stripeId.startsWith('re_')) {
      return this.stripe.refunds.retrieve(stripeId).then((it) => this.upsertRefunds([it]))
    } else if (stripeId.startsWith('feat_')) {
      return this.stripe.entitlements.features
        .retrieve(stripeId)
        .then((it) => this.upsertFeatures([it]))
    } else if (stripeId.startsWith('cs_')) {
      return this.stripe.checkout.sessions
        .retrieve(stripeId)
        .then((it) => this.upsertCheckoutSessions([it]))
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

    const params: Stripe.ProductListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams?.created

    return this.fetchAndUpsert(
      () => this.stripe.products.list(params),
      (products) => this.upsertProducts(products)
    )
  }

  async syncPrices(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing prices')

    const params: Stripe.PriceListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams?.created

    return this.fetchAndUpsert(
      () => this.stripe.prices.list(params),
      (prices) => this.upsertPrices(prices, syncParams?.backfillRelatedEntities)
    )
  }

  async syncPlans(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing plans')

    const params: Stripe.PlanListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams?.created

    return this.fetchAndUpsert(
      () => this.stripe.plans.list(params),
      (plans) => this.upsertPlans(plans, syncParams?.backfillRelatedEntities)
    )
  }

  async syncCustomers(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing customers')

    const params: Stripe.CustomerListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.customers.list(params),
      // @ts-expect-error
      (items) => this.upsertCustomers(items)
    )
  }

  async syncSubscriptions(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscriptions')

    const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.subscriptions.list(params),
      (items) => this.upsertSubscriptions(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncSubscriptionSchedules(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing subscription schedules')

    const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.subscriptionSchedules.list(params),
      (items) => this.upsertSubscriptionSchedules(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncInvoices(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing invoices')

    const params: Stripe.InvoiceListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.invoices.list(params),
      (items) => this.upsertInvoices(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncCharges(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing charges')

    const params: Stripe.ChargeListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.charges.list(params),
      (items) => this.upsertCharges(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncSetupIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing setup_intents')

    const params: Stripe.SetupIntentListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.setupIntents.list(params),
      (items) => this.upsertSetupIntents(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncPaymentIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing payment_intents')

    const params: Stripe.PaymentIntentListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.paymentIntents.list(params),
      (items) => this.upsertPaymentIntents(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncTaxIds(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing tax_ids')

    const params: Stripe.TaxIdListParams = { limit: 100 }

    return this.fetchAndUpsert(
      () => this.stripe.taxIds.list(params),
      (items) => this.upsertTaxIds(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncPaymentMethods(syncParams?: SyncBackfillParams): Promise<Sync> {
    // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
    // Thus, we need to loop through all customers
    this.config.logger?.info('Syncing payment method')

    const prepared = sql(
      `select id from "${this.config.schema}"."customers" WHERE deleted <> true;`
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
            (items) => this.upsertPaymentMethods(items, syncParams?.backfillRelatedEntities)
          )

          synced += syncResult.synced
        })
      )
    }

    return { synced }
  }

  async syncDisputes(syncParams?: SyncBackfillParams): Promise<Sync> {
    const params: Stripe.DisputeListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.disputes.list(params),
      (items) => this.upsertDisputes(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncEarlyFraudWarnings(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing early fraud warnings')

    const params: Stripe.Radar.EarlyFraudWarningListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.radar.earlyFraudWarnings.list(params),
      (items) => this.upsertEarlyFraudWarning(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncRefunds(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing refunds')

    const params: Stripe.RefundListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.refunds.list(params),
      (items) => this.upsertRefunds(items, syncParams?.backfillRelatedEntities)
    )
  }

  async syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing credit notes')

    const params: Stripe.CreditNoteListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams?.created

    return this.fetchAndUpsert(
      () => this.stripe.creditNotes.list(params),
      (creditNotes) => this.upsertCreditNotes(creditNotes)
    )
  }

  async syncFeatures(syncParams?: SyncFeaturesParams): Promise<Sync> {
    this.config.logger?.info('Syncing features')
    const params: Stripe.Entitlements.FeatureListParams = { limit: 100, ...syncParams?.pagination }
    return this.fetchAndUpsert(
      () => this.stripe.entitlements.features.list(params),
      (features) => this.upsertFeatures(features)
    )
  }

  async syncEntitlements(customerId: string, syncParams?: SyncEntitlementsParams): Promise<Sync> {
    this.config.logger?.info('Syncing entitlements')
    const params: Stripe.Entitlements.ActiveEntitlementListParams = {
      customer: customerId,
      limit: 100,
      ...syncParams?.pagination,
    }
    return this.fetchAndUpsert(
      () => this.stripe.entitlements.activeEntitlements.list(params),
      (entitlements) => this.upsertActiveEntitlements(customerId, entitlements)
    )
  }

  async syncCheckoutSessions(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing checkout sessions')

    const params: Stripe.Checkout.SessionListParams = {
      limit: 100,
    }
    if (syncParams?.created) params.created = syncParams.created

    return this.fetchAndUpsert(
      () => this.stripe.checkout.sessions.list(params),
      (items) => this.upsertCheckoutSessions(items, syncParams?.backfillRelatedEntities)
    )
  }

  private async fetchAndUpsert<T>(
    fetch: () => Stripe.ApiListPromise<T>,
    upsert: (items: T[]) => Promise<T[]>
  ): Promise<Sync> {
    const items: T[] = []

    this.config.logger?.info('Fetching items to sync from Stripe')
    for await (const item of fetch()) {
      items.push(item)
    }

    if (!items.length) return { synced: 0 }

    this.config.logger?.info(`Upserting ${items.length} items`)
    const chunkSize = 250
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize)

      await upsert(chunk)
    }
    this.config.logger?.info('Upserted items')

    return { synced: items.length }
  }

  private async upsertCharges(
    charges: Stripe.Charge[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Charge[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(charges, 'customer')),
        this.backfillInvoices(getUniqueIds(charges, 'invoice')),
      ])
    }

    await this.expandEntity(charges, 'refunds', (id) =>
      this.stripe.refunds.list({ charge: id, limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      charges,
      'charges',
      chargeSchema,
      syncTimestamp
    )
  }

  private async backfillCharges(chargeIds: string[]) {
    const missingChargeIds = await this.postgresClient.findMissingEntries('charges', chargeIds)

    await this.fetchMissingEntities(missingChargeIds, (id) =>
      this.stripe.charges.retrieve(id)
    ).then((charges) => this.upsertCharges(charges))
  }

  private async backfillPaymentIntents(paymentIntentIds: string[]) {
    const missingIds = await this.postgresClient.findMissingEntries(
      'payment_intents',
      paymentIntentIds
    )

    await this.fetchMissingEntities(missingIds, (id) =>
      this.stripe.paymentIntents.retrieve(id)
    ).then((paymentIntents) => this.upsertPaymentIntents(paymentIntents))
  }

  private async upsertCreditNotes(
    creditNotes: Stripe.CreditNote[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.CreditNote[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(creditNotes, 'customer')),
        this.backfillInvoices(getUniqueIds(creditNotes, 'invoice')),
      ])
    }

    await this.expandEntity(creditNotes, 'lines', (id) =>
      this.stripe.creditNotes.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      creditNotes,
      'credit_notes',
      creditNoteSchema,
      syncTimestamp
    )
  }

  async upsertCheckoutSessions(
    checkoutSessions: Stripe.Checkout.Session[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Checkout.Session[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(checkoutSessions, 'customer')),
        this.backfillSubscriptions(getUniqueIds(checkoutSessions, 'subscription')),
        this.backfillPaymentIntents(getUniqueIds(checkoutSessions, 'payment_intent')),
        this.backfillInvoices(getUniqueIds(checkoutSessions, 'invoice')),
      ])
    }

    // Upsert checkout sessions first
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      checkoutSessions,
      'checkout_sessions',
      checkoutSessionSchema,
      syncTimestamp
    )

    await this.fillCheckoutSessionsLineItems(
      checkoutSessions.map((cs) => cs.id),
      syncTimestamp
    )

    return rows
  }

  async upsertEarlyFraudWarning(
    earlyFraudWarnings: Stripe.Radar.EarlyFraudWarning[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Radar.EarlyFraudWarning[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(earlyFraudWarnings, 'payment_intent')),
        this.backfillCharges(getUniqueIds(earlyFraudWarnings, 'charge')),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      earlyFraudWarnings,
      'early_fraud_warnings',
      earlyFraudWarningSchema,
      syncTimestamp
    )
  }

  async upsertRefunds(
    refunds: Stripe.Refund[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Refund[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(refunds, 'payment_intent')),
        this.backfillCharges(getUniqueIds(refunds, 'charge')),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      refunds,
      'refunds',
      refundSchema,
      syncTimestamp
    )
  }

  async upsertReviews(
    reviews: Stripe.Review[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Review[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillPaymentIntents(getUniqueIds(reviews, 'payment_intent')),
        this.backfillCharges(getUniqueIds(reviews, 'charge')),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      reviews,
      'reviews',
      reviewSchema,
      syncTimestamp
    )
  }

  async upsertCustomers(
    customers: (Stripe.Customer | Stripe.DeletedCustomer)[],
    syncTimestamp?: string
  ): Promise<(Stripe.Customer | Stripe.DeletedCustomer)[]> {
    const deletedCustomers = customers.filter((customer) => customer.deleted)
    const nonDeletedCustomers = customers.filter((customer) => !customer.deleted)

    await this.postgresClient.upsertManyWithTimestampProtection(
      nonDeletedCustomers,
      'customers',
      customerSchema,
      syncTimestamp
    )
    await this.postgresClient.upsertManyWithTimestampProtection(
      deletedCustomers,
      'customers',
      customerDeletedSchema,
      syncTimestamp
    )

    return customers
  }

  async backfillCustomers(customerIds: string[]) {
    const missingIds = await this.postgresClient.findMissingEntries('customers', customerIds)

    await this.fetchMissingEntities(missingIds, (id) => this.stripe.customers.retrieve(id))
      .then((entries) => this.upsertCustomers(entries))
      .catch((err) => {
        this.config.logger?.error(err, 'Failed to backfill')
        throw err
      })
  }

  async upsertDisputes(
    disputes: Stripe.Dispute[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Dispute[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCharges(getUniqueIds(disputes, 'charge'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      disputes,
      'disputes',
      disputeSchema,
      syncTimestamp
    )
  }

  async upsertInvoices(
    invoices: Stripe.Invoice[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Invoice[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(invoices, 'customer')),
        this.backfillSubscriptions(getUniqueIds(invoices, 'subscription')),
      ])
    }

    await this.expandEntity(invoices, 'lines', (id) =>
      this.stripe.invoices.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertManyWithTimestampProtection(
      invoices,
      'invoices',
      invoiceSchema,
      syncTimestamp
    )
  }

  backfillInvoices = async (invoiceIds: string[]) => {
    const missingIds = await this.postgresClient.findMissingEntries('invoices', invoiceIds)
    await this.fetchMissingEntities(missingIds, (id) => this.stripe.invoices.retrieve(id)).then(
      (entries) => this.upsertInvoices(entries)
    )
  }

  backfillPrices = async (priceIds: string[]) => {
    const missingIds = await this.postgresClient.findMissingEntries('prices', priceIds)
    await this.fetchMissingEntities(missingIds, (id) => this.stripe.prices.retrieve(id)).then(
      (entries) => this.upsertPrices(entries)
    )
  }

  async upsertPlans(
    plans: Stripe.Plan[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Plan[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(plans, 'product'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      plans,
      'plans',
      planSchema,
      syncTimestamp
    )
  }

  async deletePlan(id: string): Promise<boolean> {
    return this.postgresClient.delete('plans', id)
  }

  async upsertPrices(
    prices: Stripe.Price[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Price[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(prices, 'product'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      prices,
      'prices',
      priceSchema,
      syncTimestamp
    )
  }

  async deletePrice(id: string): Promise<boolean> {
    return this.postgresClient.delete('prices', id)
  }

  async upsertProducts(
    products: Stripe.Product[],
    syncTimestamp?: string
  ): Promise<Stripe.Product[]> {
    return this.postgresClient.upsertManyWithTimestampProtection(
      products,
      'products',
      productSchema,
      syncTimestamp
    )
  }

  async deleteProduct(id: string): Promise<boolean> {
    return this.postgresClient.delete('products', id)
  }

  async backfillProducts(productIds: string[]) {
    const missingProductIds = await this.postgresClient.findMissingEntries('products', productIds)

    await this.fetchMissingEntities(missingProductIds, (id) =>
      this.stripe.products.retrieve(id)
    ).then((products) => this.upsertProducts(products))
  }

  async upsertPaymentIntents(
    paymentIntents: Stripe.PaymentIntent[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.PaymentIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(paymentIntents, 'customer')),
        this.backfillInvoices(getUniqueIds(paymentIntents, 'invoice')),
      ])
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      paymentIntents,
      'payment_intents',
      paymentIntentSchema,
      syncTimestamp
    )
  }

  async upsertPaymentMethods(
    paymentMethods: Stripe.PaymentMethod[],
    backfillRelatedEntities: boolean = false,
    syncTimestamp?: string
  ): Promise<Stripe.PaymentMethod[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(paymentMethods, 'customer'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      paymentMethods,
      'payment_methods',
      paymentMethodsSchema,
      syncTimestamp
    )
  }

  async upsertSetupIntents(
    setupIntents: Stripe.SetupIntent[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.SetupIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(setupIntents, 'customer'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      setupIntents,
      'setup_intents',
      setupIntentsSchema,
      syncTimestamp
    )
  }

  async upsertTaxIds(
    taxIds: Stripe.TaxId[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.TaxId[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(taxIds, 'customer'))
    }

    return this.postgresClient.upsertManyWithTimestampProtection(
      taxIds,
      'tax_ids',
      taxIdSchema,
      syncTimestamp
    )
  }

  async deleteTaxId(id: string): Promise<boolean> {
    return this.postgresClient.delete('tax_ids', id)
  }

  async upsertSubscriptionItems(
    subscriptionItems: Stripe.SubscriptionItem[],
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
      subscriptionItemSchema,
      syncTimestamp
    )
  }

  async fillCheckoutSessionsLineItems(checkoutSessionIds: string[], syncTimestamp?: string) {
    for (const checkoutSessionId of checkoutSessionIds) {
      const lineItemResponses: Stripe.LineItem[] = []

      for await (const lineItem of this.stripe.checkout.sessions.listLineItems(checkoutSessionId, {
        limit: 100,
      })) {
        lineItemResponses.push(lineItem)
      }

      await this.upsertCheckoutSessionLineItems(lineItemResponses, checkoutSessionId, syncTimestamp)
    }
  }

  async upsertCheckoutSessionLineItems(
    lineItems: Stripe.LineItem[],
    checkoutSessionId: string,
    syncTimestamp?: string
  ) {
    // prices are needed for line items relation
    await this.backfillPrices(
      lineItems
        .map((lineItem) => lineItem.price?.id?.toString() ?? undefined)
        .filter((id) => id !== undefined)
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
      checkoutSessionLineItemSchema,
      syncTimestamp
    )
  }

  async markDeletedSubscriptionItems(
    subscriptionId: string,
    currentSubItemIds: string[]
  ): Promise<{ rowCount: number }> {
    let prepared = sql(`
    select id from "${this.config.schema}"."subscription_items"
    where subscription = :subscriptionId and deleted = false;
    `)({ subscriptionId })
    const { rows } = await this.postgresClient.query(prepared.text, prepared.values)
    const deletedIds = rows.filter(
      ({ id }: { id: string }) => currentSubItemIds.includes(id) === false
    )

    if (deletedIds.length > 0) {
      const ids = deletedIds.map(({ id }: { id: string }) => id)
      prepared = sql(`
      update "${this.config.schema}"."subscription_items"
      set deleted = true where id=any(:ids::text[]);
      `)({ ids })
      const { rowCount } = await await this.postgresClient.query(prepared.text, prepared.values)
      return { rowCount: rowCount || 0 }
    } else {
      return { rowCount: 0 }
    }
  }

  async upsertSubscriptionSchedules(
    subscriptionSchedules: Stripe.SubscriptionSchedule[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.SubscriptionSchedule[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptionSchedules, 'customer')

      await this.backfillCustomers(customerIds)
    }

    // Run it
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      subscriptionSchedules,
      'subscription_schedules',
      subscriptionScheduleSchema,
      syncTimestamp
    )

    return rows
  }

  async upsertSubscriptions(
    subscriptions: Stripe.Subscription[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<Stripe.Subscription[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptions, 'customer')

      await this.backfillCustomers(customerIds)
    }

    await this.expandEntity(subscriptions, 'items', (id) =>
      this.stripe.subscriptionItems.list({ subscription: id, limit: 100 })
    )

    // Run it
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      subscriptions,
      'subscriptions',
      subscriptionSchema,
      syncTimestamp
    )

    // Upsert subscription items into a separate table
    // need to run after upsert subscription cos subscriptionItems will reference the subscription
    const allSubscriptionItems = subscriptions.flatMap((subscription) => subscription.items.data)
    await this.upsertSubscriptionItems(allSubscriptionItems, syncTimestamp)

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

  async upsertFeatures(features: Stripe.Entitlements.Feature[], syncTimestamp?: string) {
    return this.postgresClient.upsertManyWithTimestampProtection(
      features,
      'features',
      featureSchema,
      syncTimestamp
    )
  }

  async backfillFeatures(featureIds: string[]) {
    const missingFeatureIds = await this.postgresClient.findMissingEntries('features', featureIds)
    await this.fetchMissingEntities(missingFeatureIds, (id) =>
      this.stripe.entitlements.features.retrieve(id)
    )
      .then((features) => this.upsertFeatures(features))
      .catch((err) => {
        this.config.logger?.error(err, 'Failed to backfill features')
        throw err
      })
  }

  async upsertActiveEntitlements(
    customerId: string,
    activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(activeEntitlements, 'customer')),
        this.backfillFeatures(getUniqueIds(activeEntitlements, 'feature')),
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
      activeEntitlementSchema,
      syncTimestamp
    )
  }

  async backfillSubscriptions(subscriptionIds: string[]) {
    const missingSubscriptionIds = await this.postgresClient.findMissingEntries(
      'subscriptions',
      subscriptionIds
    )

    await this.fetchMissingEntities(missingSubscriptionIds, (id) =>
      this.stripe.subscriptions.retrieve(id)
    ).then((subscriptions) => this.upsertSubscriptions(subscriptions))
  }

  backfillSubscriptionSchedules = async (subscriptionIds: string[]) => {
    const missingSubscriptionIds = await this.postgresClient.findMissingEntries(
      'subscription_schedules',
      subscriptionIds
    )

    await this.fetchMissingEntities(missingSubscriptionIds, (id) =>
      this.stripe.subscriptionSchedules.retrieve(id)
    ).then((subscriptionSchedules) => this.upsertSubscriptionSchedules(subscriptionSchedules))
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
      const entity = await fetch(id)
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
