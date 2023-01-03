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
  paymentMethods?: Sync
  disputes?: Sync
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

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
  const { created, object } = params ?? {}
  let products, prices, customers, subscriptions, invoices, setupIntents, paymentMethods, disputes

  switch (object) {
    case 'all':
      products = await syncProducts(created)
      prices = await syncPrices(created)
      customers = await syncCustomers(created)
      subscriptions = await syncSubscriptions(created)
      invoices = await syncInvoices(created)
      setupIntents = await syncSetupIntents(created)
      paymentMethods = await syncPaymentMethods(created)
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
      paymentMethods = await syncPaymentMethods(created)
      break
    case 'dispute':
      disputes = await syncDisputes(created)
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
  }
}

export async function syncProducts(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing products')

  const params: Stripe.ProductListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.products.list(params),
    (products) => upsertProducts(products)
  )
}

export async function syncPrices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing prices')

  const params: Stripe.PriceListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.prices.list(params),
    (prices) => upsertPrices(prices)
  )
}

export async function syncCustomers(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing customers')

  const params: Stripe.CustomerListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.customers.list(params),
    (disputes) => upsertCustomers(disputes)
  )
}

export async function syncSubscriptions(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing subscriptions')

  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.subscriptions.list(params),
    (subscription) => upsertSubscriptions(subscription)
  )
}

export async function syncInvoices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing invoices')

  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.invoices.list(params),
    (invoice) => upsertInvoices(invoice)
  )
}

export async function syncSetupIntents(created?: Stripe.RangeQueryParam): Promise<Sync> {
  console.log('Syncing setup_intents')

  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.setupIntents.list(params),
    (setupIntents) => upsertSetupIntents(setupIntents)
  )
}

const stripePaymentTypes: Stripe.PaymentMethodListParams.Type[] = [
  'acss_debit',
  'afterpay_clearpay',
  'alipay',
  'au_becs_debit',
  'bacs_debit',
  'bancontact',
  'boleto',
  'card',
  'card_present',
  'customer_balance',
  'eps',
  'fpx',
  'giropay',
  'grabpay',
  'ideal',
  'klarna',
  'konbini',
  'oxxo',
  'p24',
  'paynow',
  'sepa_debit',
  'sofort',
  'us_bank_account',
  'wechat_pay',
]

export async function syncPaymentMethods(created?: Stripe.RangeQueryParam): Promise<Sync> {
  // We can't filter by date here

  let synced = 0
  for (const stripePaymentType of stripePaymentTypes) {
    const syncResult = await fetchAndUpsert(
      () =>
        stripe.paymentMethods.list({
          limit: 100,
          type: stripePaymentType,
        }),
      (paymentMethods) => upsertPaymentMethods(paymentMethods)
    )

    synced += syncResult.synced
  }

  return { synced }
}

export async function syncDisputes(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (created) params.created = created

  return fetchAndUpsert(
    () => stripe.disputes.list(params),
    (disputes) => upsertDisputes(disputes)
  )
}

async function fetchAndUpsert<T>(
  fetch: () => Stripe.ApiListPromise<T>,
  upsert: (items: T[]) => Promise<T[]>
): Promise<Sync> {
  const items: T[] = []

  console.log('Fetching items to sync from Stripe')
  for await (const item of fetch()) {
    items.push(item)
  }

  console.log(`Upserting ${items.length} items`)
  const chunkSize = 250
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize)

    await upsert(chunk)
  }
  console.log('Upserted items')

  return { synced: items.length }
}
