import { upsertProducts } from './products'
import { upsertPrices } from './prices'
import { upsertSubscriptions } from './subscriptions'
import { upsertInvoices } from './invoices'
import { upsertCustomers } from './customers'
import { stripe } from '../utils/StripeClientManager'
import Stripe from 'stripe'
import { upsertSetupIntents } from './setup_intents'
import { upsertPaymentMethods } from './payment_methods'
import { upsertDisputes } from './disputes'
import { upsertCharges } from './charges'
import { query } from '../utils/PostgresConnection'
import { getConfig } from '../utils/config'
import { pg as sql } from 'yesql'
import { upsertPaymentIntents } from './payment_intents'
import { upsertPlans } from './plans'
import { upsertSubscriptionSchedules } from './subscription_schedules'
import pLimit from 'p-limit'
import { upsertTaxIds } from './tax_ids'
import { upsertCreditNotes } from './creditNotes'

const config = getConfig()

interface Sync {
  synced: number
}

interface SyncBackfill {
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

type SyncObject =
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

export async function syncSingleEntity(stripeId: string) {
  if (stripeId.startsWith('cus_')) {
    return stripe.customers.retrieve(stripeId).then((it) => {
      if (!it || it.deleted) return

      return upsertCustomers([it])
    })
  } else if (stripeId.startsWith('in_')) {
    return stripe.invoices.retrieve(stripeId).then((it) => upsertInvoices([it]))
  } else if (stripeId.startsWith('price_')) {
    return stripe.prices.retrieve(stripeId).then((it) => upsertPrices([it]))
  } else if (stripeId.startsWith('prod_')) {
    return stripe.products.retrieve(stripeId).then((it) => upsertProducts([it]))
  } else if (stripeId.startsWith('sub_')) {
    return stripe.subscriptions.retrieve(stripeId).then((it) => upsertSubscriptions([it]))
  } else if (stripeId.startsWith('seti_')) {
    return stripe.setupIntents.retrieve(stripeId).then((it) => upsertSetupIntents([it]))
  } else if (stripeId.startsWith('pm_')) {
    return stripe.paymentMethods.retrieve(stripeId).then((it) => upsertPaymentMethods([it]))
  } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
    return stripe.disputes.retrieve(stripeId).then((it) => upsertDisputes([it]))
  } else if (stripeId.startsWith('ch_')) {
    return stripe.charges.retrieve(stripeId).then((it) => upsertCharges([it]))
  } else if (stripeId.startsWith('pi_')) {
    return stripe.paymentIntents.retrieve(stripeId).then((it) => upsertPaymentIntents([it]))
  } else if (stripeId.startsWith('txi_')) {
    return stripe.taxIds.retrieve(stripeId).then((it) => upsertTaxIds([it]))
  } else if (stripeId.startsWith('cn_')) {
    return stripe.creditNotes.retrieve(stripeId).then((it) => upsertCreditNotes([it]))
  }
}

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
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
      products = await syncProducts(params)
      prices = await syncPrices(params)
      plans = await syncPlans(params)
      customers = await syncCustomers(params)
      subscriptions = await syncSubscriptions(params)
      subscriptionSchedules = await syncSubscriptionSchedules(params)
      invoices = await syncInvoices(params)
      charges = await syncCharges(params)
      setupIntents = await syncSetupIntents(params)
      paymentMethods = await syncPaymentMethods(params)
      paymentIntents = await syncPaymentIntents(params)
      taxIds = await syncTaxIds(params)
      creditNotes = await syncCreditNotes(params)
      break
    case 'customer':
      customers = await syncCustomers(params)
      break
    case 'invoice':
      invoices = await syncInvoices(params)
      break
    case 'price':
      prices = await syncPrices(params)
      break
    case 'product':
      products = await syncProducts(params)
      break
    case 'subscription':
      subscriptions = await syncSubscriptions(params)
      break
    case 'subscription_schedules':
      subscriptionSchedules = await syncSubscriptionSchedules(params)
      break
    case 'setup_intent':
      setupIntents = await syncSetupIntents(params)
      break
    case 'payment_method':
      paymentMethods = await syncPaymentMethods(params)
      break
    case 'dispute':
      disputes = await syncDisputes(params)
      break
    case 'charge':
      charges = await syncCharges(params)
      break
    case 'payment_intent':
      paymentIntents = await syncPaymentIntents(params)
    case 'plan':
      plans = await syncPlans(params)
      break
    case 'tax_id':
      taxIds = await syncTaxIds(params)
      break
    case 'credit_note':
      creditNotes = await syncCreditNotes(params)
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

export async function syncProducts(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing products')

  const params: Stripe.ProductListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.products.list(params),
    (products) => upsertProducts(products)
  )
}

export async function syncPrices(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing prices')

  const params: Stripe.PriceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.prices.list(params),
    (prices) => upsertPrices(prices, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPlans(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing plans')

  const params: Stripe.PlanListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.plans.list(params),
    (plans) => upsertPlans(plans, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCustomers(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing customers')

  const params: Stripe.CustomerListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.customers.list(params),
    (items) => upsertCustomers(items)
  )
}

export async function syncSubscriptions(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing subscriptions')

  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.subscriptions.list(params),
    (items) => upsertSubscriptions(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncSubscriptionSchedules(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing subscription schedules')

  const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.subscriptionSchedules.list(params),
    (items) => upsertSubscriptionSchedules(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncInvoices(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing invoices')

  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.invoices.list(params),
    (items) => upsertInvoices(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCharges(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing charges')

  const params: Stripe.ChargeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.charges.list(params),
    (items) => upsertCharges(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncSetupIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing setup_intents')

  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.setupIntents.list(params),
    (items) => upsertSetupIntents(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentIntents(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing payment_intents')

  const params: Stripe.PaymentIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.paymentIntents.list(params),
    (items) => upsertPaymentIntents(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncTaxIds(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing tax_ids')

  const params: Stripe.TaxIdListParams = { limit: 100 }

  return fetchAndUpsert(
    () => stripe.taxIds.list(params),
    (items) => upsertTaxIds(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentMethods(syncParams?: SyncBackfillParams): Promise<Sync> {
  // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
  // Thus, we need to loop through all customers
  console.log('Syncing payment method')

  const prepared = sql(`select id from "${config.SCHEMA}"."customers" WHERE deleted <> true;`)([])

  const customerIds = await query(prepared.text, prepared.values).then(({ rows }) =>
    rows.map((it) => it.id)
  )

  console.log(`Getting payment methods for ${customerIds.length} customers`)

  let synced = 0

  // 10 in parallel
  const limit = pLimit(10)

  const syncs = customerIds.map((customerId) =>
    limit(async () => {
      const syncResult = await fetchAndUpsert(
        () =>
          stripe.paymentMethods.list({
            limit: 100,
            customer: customerId,
          }),
        (items) => upsertPaymentMethods(items, syncParams?.backfillRelatedEntities)
      )

      synced += syncResult.synced
    })
  )

  await Promise.all(syncs)

  return { synced }
}

export async function syncDisputes(syncParams?: SyncBackfillParams): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.disputes.list(params),
    (items) => upsertDisputes(items, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCreditNotes(syncParams?: SyncBackfillParams): Promise<Sync> {
  console.log('Syncing credit notes')

  const params: Stripe.CreditNoteListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.creditNotes.list(params),
    (creditNotes) => upsertCreditNotes(creditNotes)
  )
}

async function fetchAndUpsert<T>(
  fetch: () => Stripe.ApiListPromise<T>,
  upsert: (items: T[]) => Promise<T[]>
): Promise<Sync> {
  const items: T[] = []

  console.log('Fetching items to sync from Stripe')
  try {
    for await (const item of fetch()) {
      items.push(item)
    }
  } catch (err) {
    console.error(err)
  }

  if (!items.length) return { synced: 0 }

  console.log(`Upserting ${items.length} items`)
  const chunkSize = 250
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)

    await upsert(chunk)
  }
  console.log('Upserted items')

  return { synced: items.length }
}
