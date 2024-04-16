import Stripe from 'stripe'
import { upsertCustomers } from './customers'
import { upsertInvoices } from './invoices'
import { upsertPrices } from './prices'
import { upsertProducts } from './products'
import { upsertSubscriptions } from './subscriptions'
import { upsertSetupIntents } from './setup_intents'
import { upsertPaymentMethods } from './payment_methods'
import { upsertDisputes } from './disputes'
import { upsertCharges } from './charges'
import { upsertPaymentIntents } from './payment_intents'
import { upsertTaxIds } from './tax_ids'
import { upsertPlans } from './plans'
import { upsertSubscriptionSchedules } from './subscription_schedules'
import pLimit from 'p-limit'
import { pg as sql } from 'yesql'
import { PostgresClient } from '../database/postgres'
import { ConfigType } from '../types/types'

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

export async function syncSingleEntity(
  stripeId: string,
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType
) {
  if (stripeId.startsWith('cus_')) {
    return stripe.customers.retrieve(stripeId).then((it) => {
      if (!it || it.deleted) return

      return upsertCustomers([it], pgClient)
    })
  } else if (stripeId.startsWith('in_')) {
    return stripe.invoices
      .retrieve(stripeId)
      .then((it) => upsertInvoices([it], pgClient, stripe, config))
  } else if (stripeId.startsWith('price_')) {
    return stripe.prices.retrieve(stripeId).then((it) => upsertPrices([it], pgClient, stripe))
  } else if (stripeId.startsWith('prod_')) {
    return stripe.products.retrieve(stripeId).then((it) => upsertProducts([it], pgClient))
  } else if (stripeId.startsWith('sub_')) {
    return stripe.subscriptions
      .retrieve(stripeId)
      .then((it) => upsertSubscriptions([it], pgClient, stripe, config))
  } else if (stripeId.startsWith('seti_')) {
    return stripe.setupIntents
      .retrieve(stripeId)
      .then((it) => upsertSetupIntents([it], pgClient, stripe))
  } else if (stripeId.startsWith('pm_')) {
    return stripe.paymentMethods
      .retrieve(stripeId)
      .then((it) => upsertPaymentMethods([it], pgClient, stripe))
  } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
    return stripe.disputes
      .retrieve(stripeId)
      .then((it) => upsertDisputes([it], pgClient, stripe, config))
  } else if (stripeId.startsWith('ch_')) {
    return stripe.charges
      .retrieve(stripeId)
      .then((it) => upsertCharges([it], pgClient, stripe, config))
  } else if (stripeId.startsWith('pi_')) {
    return stripe.paymentIntents
      .retrieve(stripeId)
      .then((it) => upsertPaymentIntents([it], pgClient, stripe, config))
  } else if (stripeId.startsWith('txi_')) {
    return stripe.taxIds.retrieve(stripeId).then((it) => upsertTaxIds([it], pgClient, stripe))
  }
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
  backfillRelatedEntities?: boolean
}

export async function syncBackfill(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  params?: SyncBackfillParams
): Promise<SyncBackfill> {
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
    taxIds

  switch (object) {
    case 'all':
      products = await syncProducts(pgClient, stripe, params)
      prices = await syncPrices(pgClient, stripe, params)
      plans = await syncPlans(pgClient, stripe, params)
      customers = await syncCustomers(pgClient, stripe, params)
      subscriptions = await syncSubscriptions(pgClient, stripe, config, params)
      subscriptionSchedules = await syncSubscriptionSchedules(pgClient, stripe, params)
      invoices = await syncInvoices(pgClient, stripe, config, params)
      charges = await syncCharges(pgClient, stripe, config, params)
      setupIntents = await syncSetupIntents(pgClient, stripe, params)

      paymentMethods = await syncPaymentMethods(pgClient, stripe, config, params)
      paymentIntents = await syncPaymentIntents(pgClient, stripe, config, params)
      taxIds = await syncTaxIds(pgClient, stripe, params)
      break
    case 'customer':
      customers = await syncCustomers(pgClient, stripe, params)
      break
    case 'invoice':
      invoices = await syncInvoices(pgClient, stripe, config, params)
      break
    case 'price':
      prices = await syncPrices(pgClient, stripe, params)
      break
    case 'product':
      products = await syncProducts(pgClient, stripe, params)
      break

    case 'subscription':
      subscriptions = await syncSubscriptions(pgClient, stripe, config, params)
      break
    case 'subscription_schedules':
      subscriptionSchedules = await syncSubscriptionSchedules(pgClient, stripe, params)
      break
    case 'setup_intent':
      setupIntents = await syncSetupIntents(pgClient, stripe, params)
      break
    case 'payment_method':
      paymentMethods = await syncPaymentMethods(pgClient, stripe, config, params)
      break
    case 'dispute':
      disputes = await syncDisputes(pgClient, stripe, config, params)
      break
    case 'charge':
      charges = await syncCharges(pgClient, stripe, config, params)
      break
    case 'payment_intent':
      paymentIntents = await syncPaymentIntents(pgClient, stripe, config, params)
    case 'plan':
      plans = await syncPlans(pgClient, stripe, params)
      break
    case 'tax_id':
      taxIds = await syncTaxIds(pgClient, stripe, params)
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
  }
}

export async function syncProducts(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing products')

  const params: Stripe.ProductListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.products.list(params),
    (products) => upsertProducts(products, pgClient)
  )
}

export async function syncPrices(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing prices')

  const params: Stripe.PriceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.prices.list(params),
    (prices) => upsertPrices(prices, pgClient, stripe, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPlans(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing plans')

  const params: Stripe.PlanListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => stripe.plans.list(params),
    (plans) => upsertPlans(plans, pgClient, stripe, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCustomers(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing customers')

  const params: Stripe.CustomerListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.customers.list(params),
    (items) => upsertCustomers(items, pgClient)
  )
}

export async function syncSubscriptions(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing subscriptions')

  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.subscriptions.list(params),
    (items) =>
      upsertSubscriptions(items, pgClient, stripe, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncSubscriptionSchedules(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing subscription schedules')

  const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.subscriptionSchedules.list(params),
    (items) =>
      upsertSubscriptionSchedules(items, pgClient, stripe, syncParams?.backfillRelatedEntities)
  )
}

export async function syncInvoices(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing invoices')

  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.invoices.list(params),
    (items) => upsertInvoices(items, pgClient, stripe, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCharges(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing charges')

  const params: Stripe.ChargeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.charges.list(params),
    (items) => upsertCharges(items, pgClient, stripe, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncSetupIntents(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing setup_intents')

  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.setupIntents.list(params),
    (items) => upsertSetupIntents(items, pgClient, stripe, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentIntents(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing payment_intents')

  const params: Stripe.PaymentIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.paymentIntents.list(params),
    (items) =>
      upsertPaymentIntents(items, pgClient, stripe, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncTaxIds(
  pgClient: PostgresClient,
  stripe: Stripe,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing tax_ids')

  const params: Stripe.TaxIdListParams = { limit: 100 }

  return fetchAndUpsert(
    () => stripe.taxIds.list(params),

    (items) => upsertTaxIds(items, pgClient, stripe, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentMethods(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
  // Thus, we need to loop through all customers
  console.log('Syncing payment method')

  const prepared = sql(`select id from "${config.SCHEMA}"."customers" WHERE deleted <> true;`)([])

  const customerIds = await pgClient
    .query(prepared.text, prepared.values)
    .then(({ rows }) => rows.map((it) => it.id))

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
        (items) =>
          upsertPaymentMethods(items, pgClient, stripe, syncParams?.backfillRelatedEntities)
      )

      synced += syncResult.synced
    })
  )

  await Promise.all(syncs)

  return { synced }
}

export async function syncDisputes(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => stripe.disputes.list(params),
    (items) => upsertDisputes(items, pgClient, stripe, config, syncParams?.backfillRelatedEntities)
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
