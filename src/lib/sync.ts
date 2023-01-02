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

const config = getConfig()

interface Sync {
  synced: number
}

interface SyncBackfill {
  products?: Sync
  prices?: Sync
  customers?: Sync
  subscriptions?: Sync
  invoices?: Sync
  setupIntents?: Sync
  paymentIntents?: Sync
  paymentMethods?: Sync
  disputes?: Sync
  charges?: Sync
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
}

type SyncObject =
  | 'all'
  | 'customer'
  | 'invoice'
  | 'price'
  | 'product'
  | 'subscription'
  | 'setup_intent'
  | 'payment_method'
  | 'dispute'
  | 'charge'
  | 'payment_intent'

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
  const { created, object } = params ?? {}
  let products,
    prices,
    customers,
    subscriptions,
    invoices,
    setupIntents,
    paymentMethods,
    disputes,
    charges,
    paymentIntents

  switch (object) {
    case 'all':
      products = await syncProducts(created)
      prices = await syncPrices(created)
      customers = await syncCustomers(created)
      subscriptions = await syncSubscriptions(created)
      invoices = await syncInvoices(created)
      charges = await syncCharges(created)
      setupIntents = await syncSetupIntents(created)
      paymentMethods = await syncPaymentMethods()
      paymentIntents = await syncPaymentIntents(created)
      break
    case 'customer':
      customers = await syncCustomers(created)
      break
    case 'invoice':
      invoices = await syncInvoices(created)
      break
    case 'price':
      prices = await syncPrices(created)
      break
    case 'product':
      products = await syncProducts(created)
      break
    case 'subscription':
      subscriptions = await syncSubscriptions(created)
      break
    case 'setup_intent':
      setupIntents = await syncSetupIntents(created)
      break
    case 'payment_method':
      paymentMethods = await syncPaymentMethods()
      break
    case 'dispute':
      disputes = await syncDisputes(created)
      break
    case 'charge':
      charges = await syncCharges(created)
      break
    case 'payment_intent':
      paymentIntents = await syncPaymentIntents(created)
      break
    default:
      break
  }

  return {
    products,
    prices,
    customers,
    subscriptions,
    invoices,
    setupIntents,
    paymentMethods,
    disputes,
    charges,
    paymentIntents,
  }
}

export async function syncProducts(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing products')

  const params: Stripe.ProductListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.products.list(params), upsertProducts)
}

export async function syncPrices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing prices')

  const params: Stripe.PriceListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.prices.list(params), upsertPrices)
}

export async function syncCustomers(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing customers')

  const params: Stripe.CustomerListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.customers.list(params), upsertCustomers)
}

export async function syncSubscriptions(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing subscriptions')

  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.subscriptions.list(params), upsertSubscriptions)
}

export async function syncInvoices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing invoices')

  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.invoices.list(params), upsertInvoices)
}

export async function syncCharges(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing charges')

  const params: Stripe.ChargeListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.charges.list(params), upsertCharges)
}

export async function syncSetupIntents(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing setup_intents')

  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.setupIntents.list(params), upsertSetupIntents)
}

export async function syncPaymentIntents(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing payment_intents')

  const params: Stripe.PaymentIntentListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.paymentIntents.list(params), upsertPaymentIntents)
}

export async function syncPaymentMethods(): Promise<Sync> {
  // We can't filter by date here, it is also not possible to get payment methods without specifying a customer (you need Stripe Sigma for that -.-)
  // Thus, we need to loop through all customers
  console.log('Syncing payment method')

  const prepared = sql(`select id from "${config.SCHEMA}"."customers" WHERE deleted <> true;`)([])

  const customerIds = await query(prepared.text, prepared.values).then(({ rows }) =>
    rows.map((it) => it.id)
  )

  console.log(`Getting payment methods for ${customerIds.length} customers`)

  let synced = 0

  for (const customerId of customerIds) {
    const syncResult = await fetchAndUpsert(
      () =>
        // The type parameter is optional, types are wrong
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        stripe.paymentMethods.list({
          limit: 100,
          customer: customerId,
        }),
      upsertPaymentMethods
    )

    synced += syncResult.synced
  }

  return { synced }
}

export async function syncDisputes(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(() => stripe.disputes.list(params), upsertDisputes)
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
