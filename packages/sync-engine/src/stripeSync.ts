import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import { PostgresClient } from './database/postgres'
import { chargeSchema } from './schemas/charge'
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
import { StripeSyncConfig, Sync, SyncBackfill, SyncBackfillParams } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getUniqueIds(entries: any[], key: string): string[] {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key]?.toString())
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

    this.postgresClient = new PostgresClient({
      databaseUrl: config.databaseUrl,
      schema: config.schema || DEFAULT_SCHEMA,
      maxConnections: config.maxPostgresConnections,
    })
  }

  async processWebhook(payload: Buffer | string, signature: string | undefined) {
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature!,
      this.config.stripeWebhookSecret
    )

    switch (event.type) {
      case 'charge.captured':
      case 'charge.expired':
      case 'charge.failed':
      case 'charge.pending':
      case 'charge.refunded':
      case 'charge.succeeded':
      case 'charge.updated': {
        const charge = await this.fetchOrUseWebhookData(event.data.object as Stripe.Charge, (id) =>
          this.stripe.charges.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for charge ${charge.id}`
        )

        await this.upsertCharges([charge])
        break
      }
      case 'customer.created':
      case 'customer.deleted':
      case 'customer.updated': {
        const customer = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Customer | Stripe.DeletedCustomer,
          (id) => this.stripe.customers.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for customer ${customer.id}`
        )

        await this.upsertCustomers([customer])
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
        const subscription = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Subscription,
          (id) => this.stripe.subscriptions.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for subscription ${subscription.id}`
        )

        await this.upsertSubscriptions([subscription])
        break
      }
      case 'customer.tax_id.updated':
      case 'customer.tax_id.created': {
        const taxId = await this.fetchOrUseWebhookData(event.data.object as Stripe.TaxId, (id) =>
          this.stripe.taxIds.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for taxId ${taxId.id}`
        )

        await this.upsertTaxIds([taxId])
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
        const invoice = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Invoice,
          (id) => this.stripe.invoices.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for invoice ${invoice.id}`
        )

        await this.upsertInvoices([invoice])
        break
      }
      case 'product.created':
      case 'product.updated': {
        try {
          const product = await this.fetchOrUseWebhookData(
            event.data.object as Stripe.Product,
            (id) => this.stripe.products.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for product ${product.id}`
          )

          await this.upsertProducts([product])
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
          const price = await this.fetchOrUseWebhookData(event.data.object as Stripe.Price, (id) =>
            this.stripe.prices.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for price ${price.id}`
          )

          await this.upsertPrices([price])
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
          const plan = await this.fetchOrUseWebhookData(event.data.object as Stripe.Plan, (id) =>
            this.stripe.plans.retrieve(id)
          )

          this.config.logger?.info(
            `Received webhook ${event.id}: ${event.type} for plan ${plan.id}`
          )

          await this.upsertPlans([plan])
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
        const setupIntent = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.SetupIntent,
          (id) => this.stripe.setupIntents.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for setupIntent ${setupIntent.id}`
        )

        await this.upsertSetupIntents([setupIntent])
        break
      }
      case 'subscription_schedule.aborted':
      case 'subscription_schedule.canceled':
      case 'subscription_schedule.completed':
      case 'subscription_schedule.created':
      case 'subscription_schedule.expiring':
      case 'subscription_schedule.released':
      case 'subscription_schedule.updated': {
        const subscriptionSchedule = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.SubscriptionSchedule,
          (id) => this.stripe.subscriptionSchedules.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for subscriptionSchedule ${subscriptionSchedule.id}`
        )

        await this.upsertSubscriptionSchedules([subscriptionSchedule])
        break
      }
      case 'payment_method.attached':
      case 'payment_method.automatically_updated':
      case 'payment_method.detached':
      case 'payment_method.updated': {
        const paymentMethod = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.PaymentMethod,
          (id) => this.stripe.paymentMethods.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for paymentMethod ${paymentMethod.id}`
        )

        await this.upsertPaymentMethods([paymentMethod])
        break
      }
      case 'charge.dispute.created':
      case 'charge.dispute.funds_reinstated':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed': {
        const dispute = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.Dispute,
          (id) => this.stripe.disputes.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for dispute ${dispute.id}`
        )

        await this.upsertDisputes([dispute])
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
        const paymentIntent = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.PaymentIntent,
          (id) => this.stripe.paymentIntents.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for paymentIntent ${paymentIntent.id}`
        )

        await this.upsertPaymentIntents([paymentIntent])
        break
      }

      case 'credit_note.created':
      case 'credit_note.updated':
      case 'credit_note.voided': {
        const creditNote = await this.fetchOrUseWebhookData(
          event.data.object as Stripe.CreditNote,
          (id) => this.stripe.creditNotes.retrieve(id)
        )

        this.config.logger?.info(
          `Received webhook ${event.id}: ${event.type} for creditNote ${creditNote.id}`
        )

        await this.upsertCreditNotes([creditNote])
        break
      }

      default:
        throw new Error('Unhandled webhook event')
    }
  }

  private async fetchOrUseWebhookData<T extends { id?: string }>(
    entity: T,
    fetchFn: (id: string) => Promise<T>
  ): Promise<T> {
    if (!entity.id) return entity

    if (this.config.revalidateEntityViaStripeApi) {
      return fetchFn(entity.id)
    }

    return entity
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
    }
  }

  async syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
    const { object } = params ?? {}
    let products,
      prices,
      customers,
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
      creditNotes

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
      default:
        break
    }

    return {
      products,
      prices,
      customers,
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

  async syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync> {
    this.config.logger?.info('Syncing credit notes')

    const params: Stripe.CreditNoteListParams = { limit: 100 }
    if (syncParams?.created) params.created = syncParams?.created

    return this.fetchAndUpsert(
      () => this.stripe.creditNotes.list(params),
      (creditNotes) => this.upsertCreditNotes(creditNotes)
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
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Charge[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(charges, 'customer')),
        this.backfillInvoices(getUniqueIds(charges, 'invoice')),
      ])
    }

    // Stripe only sends the first 10 refunds by default, the option will actively fetch all refunds

    await this.expandEntity(charges, 'refunds', (id) =>
      this.stripe.refunds.list({ charge: id, limit: 100 })
    )

    return this.postgresClient.upsertMany(charges, 'charges', chargeSchema)
  }

  private async backfillCharges(chargeIds: string[]) {
    const missingChargeIds = await this.postgresClient.findMissingEntries('charges', chargeIds)

    await this.fetchMissingEntities(missingChargeIds, (id) =>
      this.stripe.charges.retrieve(id)
    ).then((charges) => this.upsertCharges(charges))
  }

  private async upsertCreditNotes(
    creditNotes: Stripe.CreditNote[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.CreditNote[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(creditNotes, 'customer')),
        this.backfillInvoices(getUniqueIds(creditNotes, 'invoice')),
      ])
    }

    // Stripe only sends the first 10 line items by default, the option will actively fetch all line items
    await this.expandEntity(creditNotes, 'lines', (id) =>
      this.stripe.creditNotes.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertMany(creditNotes, 'credit_notes', creditNoteSchema)
  }

  async upsertCustomers(
    customers: (Stripe.Customer | Stripe.DeletedCustomer)[]
  ): Promise<(Stripe.Customer | Stripe.DeletedCustomer)[]> {
    const deletedCustomers = customers.filter((customer) => customer.deleted)
    const nonDeletedCustomers = customers.filter((customer) => !customer.deleted)

    await this.postgresClient.upsertMany(nonDeletedCustomers, 'customers', customerSchema)
    await this.postgresClient.upsertMany(deletedCustomers, 'customers', customerDeletedSchema)

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
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Dispute[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCharges(getUniqueIds(disputes, 'charge'))
    }

    return this.postgresClient.upsertMany(disputes, 'disputes', disputeSchema)
  }

  async upsertInvoices(
    invoices: Stripe.Invoice[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Invoice[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(invoices, 'customer')),
        this.backfillSubscriptions(getUniqueIds(invoices, 'subscription')),
      ])
    }

    // Stripe only sends the first 10 line items by default, the option will actively fetch all line items

    await this.expandEntity(invoices, 'lines', (id) =>
      this.stripe.invoices.listLineItems(id, { limit: 100 })
    )

    return this.postgresClient.upsertMany(invoices, 'invoices', invoiceSchema)
  }

  backfillInvoices = async (invoiceIds: string[]) => {
    const missingIds = await this.postgresClient.findMissingEntries('invoices', invoiceIds)
    await this.fetchMissingEntities(missingIds, (id) => this.stripe.invoices.retrieve(id)).then(
      (entries) => this.upsertInvoices(entries)
    )
  }

  async upsertPlans(
    plans: Stripe.Plan[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Plan[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(plans, 'product'))
    }

    return this.postgresClient.upsertMany(plans, 'plans', planSchema)
  }

  async deletePlan(id: string): Promise<boolean> {
    return this.postgresClient.delete('plans', id)
  }

  async upsertPrices(
    prices: Stripe.Price[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Price[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillProducts(getUniqueIds(prices, 'product'))
    }

    return this.postgresClient.upsertMany(prices, 'prices', priceSchema)
  }

  async deletePrice(id: string): Promise<boolean> {
    return this.postgresClient.delete('prices', id)
  }

  async upsertProducts(products: Stripe.Product[]): Promise<Stripe.Product[]> {
    return this.postgresClient.upsertMany(products, 'products', productSchema)
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
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.PaymentIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all([
        this.backfillCustomers(getUniqueIds(paymentIntents, 'customer')),
        this.backfillInvoices(getUniqueIds(paymentIntents, 'invoice')),
      ])
    }

    return this.postgresClient.upsertMany(paymentIntents, 'payment_intents', paymentIntentSchema)
  }

  async upsertPaymentMethods(
    paymentMethods: Stripe.PaymentMethod[],
    backfillRelatedEntities: boolean = false
  ): Promise<Stripe.PaymentMethod[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(paymentMethods, 'customer'))
    }

    return this.postgresClient.upsertMany(paymentMethods, 'payment_methods', paymentMethodsSchema)
  }

  async upsertSetupIntents(
    setupIntents: Stripe.SetupIntent[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.SetupIntent[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(setupIntents, 'customer'))
    }

    return this.postgresClient.upsertMany(setupIntents, 'setup_intents', setupIntentsSchema)
  }

  async upsertTaxIds(
    taxIds: Stripe.TaxId[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.TaxId[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await this.backfillCustomers(getUniqueIds(taxIds, 'customer'))
    }

    return this.postgresClient.upsertMany(taxIds, 'tax_ids', taxIdSchema)
  }

  async deleteTaxId(id: string): Promise<boolean> {
    return this.postgresClient.delete('tax_ids', id)
  }

  async upsertSubscriptionItems(subscriptionItems: Stripe.SubscriptionItem[]) {
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

    await this.postgresClient.upsertMany(
      modifiedSubscriptionItems,
      'subscription_items',
      subscriptionItemSchema
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
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.SubscriptionSchedule[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptionSchedules, 'customer')

      await this.backfillCustomers(customerIds)
    }

    // Run it
    const rows = await this.postgresClient.upsertMany(
      subscriptionSchedules,
      'subscription_schedules',
      subscriptionScheduleSchema
    )

    return rows
  }

  async upsertSubscriptions(
    subscriptions: Stripe.Subscription[],
    backfillRelatedEntities?: boolean
  ): Promise<Stripe.Subscription[]> {
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      const customerIds = getUniqueIds(subscriptions, 'customer')

      await this.backfillCustomers(customerIds)
    }

    // Stripe only sends the first 10 items by default, the option will actively fetch all items
    await this.expandEntity(subscriptions, 'items', (id) =>
      this.stripe.subscriptionItems.list({ subscription: id, limit: 100 })
    )

    // Run it
    const rows = await this.postgresClient.upsertMany(
      subscriptions,
      'subscriptions',
      subscriptionSchema
    )

    // Upsert subscription items into a separate table
    // need to run after upsert subscription cos subscriptionItems will reference the subscription
    const allSubscriptionItems = subscriptions.flatMap((subscription) => subscription.items.data)
    await this.upsertSubscriptionItems(allSubscriptionItems)

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

  private async expandEntity<
    K,
    P extends string,
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
