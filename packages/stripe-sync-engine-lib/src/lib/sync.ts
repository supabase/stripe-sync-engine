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
import { query } from '../utils/PostgresConnection'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

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

export async function syncSingleEntity(stripeId: string, config: ConfigType) {
  if (stripeId.startsWith('cus_')) {
    return getStripe(config)
      .customers.retrieve(stripeId)
      .then((it) => {
        if (!it || it.deleted) return

        return upsertCustomers([it], config)
      })
  } else if (stripeId.startsWith('in_')) {
    return getStripe(config)
      .invoices.retrieve(stripeId)
      .then((it) => upsertInvoices([it], config))
  } else if (stripeId.startsWith('price_')) {
    return getStripe(config)
      .prices.retrieve(stripeId)
      .then((it) => upsertPrices([it], config))
  } else if (stripeId.startsWith('prod_')) {
    return getStripe(config)
      .products.retrieve(stripeId)
      .then((it) => upsertProducts([it], config))
  } else if (stripeId.startsWith('sub_')) {
    return getStripe(config)
      .subscriptions.retrieve(stripeId)
      .then((it) => upsertSubscriptions([it], config))
  } else if (stripeId.startsWith('seti_')) {
    return getStripe(config)
      .setupIntents.retrieve(stripeId)
      .then((it) => upsertSetupIntents([it], config))
  } else if (stripeId.startsWith('pm_')) {
    return getStripe(config)
      .paymentMethods.retrieve(stripeId)
      .then((it) => upsertPaymentMethods([it], config))
  } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
    return getStripe(config)
      .disputes.retrieve(stripeId)
      .then((it) => upsertDisputes([it], config))
  } else if (stripeId.startsWith('ch_')) {
    return getStripe(config)
      .charges.retrieve(stripeId)
      .then((it) => upsertCharges([it], true, config))
  } else if (stripeId.startsWith('pi_')) {
    return getStripe(config)
      .paymentIntents.retrieve(stripeId)
      .then((it) => upsertPaymentIntents([it], config))
  } else if (stripeId.startsWith('txi_')) {
    return getStripe(config)
      .taxIds.retrieve(stripeId)
      .then((it) => upsertTaxIds([it], config))
  }
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
  backfillRelatedEntities?: boolean
}

export async function syncBackfill(
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
      products = await syncProducts(config, params)
      prices = await syncPrices(config, params)
      plans = await syncPlans(config, params)
      customers = await syncCustomers(config, params)
      subscriptions = await syncSubscriptions(config, params)
      subscriptionSchedules = await syncSubscriptionSchedules(config, params)
      invoices = await syncInvoices(config, params)
      charges = await syncCharges(config, params)
      setupIntents = await syncSetupIntents(config, params)

      paymentMethods = await syncPaymentMethods(config, params)
      paymentIntents = await syncPaymentIntents(config, params)
      taxIds = await syncTaxIds(config, params)
      break
    case 'customer':
      customers = await syncCustomers(config, params)
      break
    case 'invoice':
      invoices = await syncInvoices(config, params)
      break
    case 'price':
      prices = await syncPrices(config, params)
      break
    case 'product':
      products = await syncProducts(config, params)
      break

    case 'subscription':
      subscriptions = await syncSubscriptions(config, params)
      break
    case 'subscription_schedules':
      subscriptionSchedules = await syncSubscriptionSchedules(config, params)
      break
    case 'setup_intent':
      setupIntents = await syncSetupIntents(config, params)
      break
    case 'payment_method':
      paymentMethods = await syncPaymentMethods(config, params)
      break
    case 'dispute':
      disputes = await syncDisputes(config, params)
      break
    case 'charge':
      charges = await syncCharges(config, params)
      break
    case 'payment_intent':
      paymentIntents = await syncPaymentIntents(config, params)
    case 'plan':
      plans = await syncPlans(config, params)
      break
    case 'tax_id':
      taxIds = await syncTaxIds(config, params)
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
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing products')

  const params: Stripe.ProductListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => getStripe(config).products.list(params),
    (products) => upsertProducts(products, config)
  )
}

export async function syncPrices(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing prices')

  const params: Stripe.PriceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => getStripe(config).prices.list(params),
    (prices) => upsertPrices(prices, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPlans(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing plans')

  const params: Stripe.PlanListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams?.created

  return fetchAndUpsert(
    () => getStripe(config).plans.list(params),
    (plans) => upsertPlans(plans, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCustomers(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing customers')

  const params: Stripe.CustomerListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).customers.list(params),
    (items) => upsertCustomers(items, config)
  )
}

export async function syncSubscriptions(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing subscriptions')

  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).subscriptions.list(params),
    (items) => upsertSubscriptions(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncSubscriptionSchedules(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing subscription schedules')

  const params: Stripe.SubscriptionScheduleListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).subscriptionSchedules.list(params),
    (items) => upsertSubscriptionSchedules(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncInvoices(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing invoices')

  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).invoices.list(params),
    (items) => upsertInvoices(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncCharges(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing charges')

  const params: Stripe.ChargeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).charges.list(params),
    (items) => upsertCharges(items, syncParams?.backfillRelatedEntities, config)
  )
}

export async function syncSetupIntents(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing setup_intents')

  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).setupIntents.list(params),
    (items) => upsertSetupIntents(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentIntents(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing payment_intents')

  const params: Stripe.PaymentIntentListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).paymentIntents.list(params),
    (items) => upsertPaymentIntents(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncTaxIds(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  console.log('Syncing tax_ids')

  const params: Stripe.TaxIdListParams = { limit: 100 }

  return fetchAndUpsert(
    () => getStripe(config).taxIds.list(params),

    (items) => upsertTaxIds(items, config, syncParams?.backfillRelatedEntities)
  )
}

export async function syncPaymentMethods(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
  // Thus, we need to loop through all customers
  console.log('Syncing payment method')

  const prepared = sql(`select id from "${config.SCHEMA}"."customers" WHERE deleted <> true;`)([])

  const customerIds = await query(prepared.text, config.DATABASE_URL, prepared.values).then(
    ({ rows }) => rows.map((it) => it.id)
  )

  console.log(`Getting payment methods for ${customerIds.length} customers`)

  let synced = 0

  // 10 in parallel
  const limit = pLimit(10)

  const syncs = customerIds.map((customerId) =>
    limit(async () => {
      const syncResult = await fetchAndUpsert(
        () =>
          getStripe(config).paymentMethods.list({
            limit: 100,
            customer: customerId,
          }),
        (items) => upsertPaymentMethods(items, config, syncParams?.backfillRelatedEntities)
      )

      synced += syncResult.synced
    })
  )

  await Promise.all(syncs)

  return { synced }
}

export async function syncDisputes(
  config: ConfigType,
  syncParams?: SyncBackfillParams
): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (syncParams?.created) params.created = syncParams.created

  return fetchAndUpsert(
    () => getStripe(config).disputes.list(params),
    (items) => upsertDisputes(items, config, syncParams?.backfillRelatedEntities)
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
