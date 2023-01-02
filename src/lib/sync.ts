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
  const params: Stripe.ProductListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const product of stripe.products.list(params)) {
    await upsertProducts([product])
    synced++
  }

  return { synced }
}

export async function syncPrices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.PriceListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const price of stripe.prices.list(params)) {
    await upsertPrices([price])
    synced++
  }

  return { synced }
}

export async function syncCustomers(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.CustomerListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const customer of stripe.customers.list(params)) {
    await upsertCustomers([customer])
    synced++
  }

  return { synced }
}

export async function syncSubscriptions(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const subscription of stripe.subscriptions.list(params)) {
    await upsertSubscriptions([subscription])
    synced++
  }

  return { synced }
}

export async function syncInvoices(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const invoice of stripe.invoices.list(params)) {
    await upsertInvoices([invoice])
    synced++
  }

  return { synced }
}

export async function syncSetupIntents(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.SetupIntentListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const setupIntent of stripe.setupIntents.list(params)) {
    await upsertSetupIntents([setupIntent])
    synced++
  }

  return { synced }
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
    for await (const paymentMethod of stripe.paymentMethods.list({
      limit: 100,
      type: stripePaymentType,
    })) {
      const creationDate = new Date(paymentMethod.created * 1000)

      // If a created at filter is set, skip upsert (unfortunately we must always query)
      if (!created || creationDate >= created) {
        await upsertPaymentMethods([paymentMethod])
        synced++
      }
    }
  }

  return { synced }
}

export async function syncDisputes(created?: Stripe.RangeQueryParam): Promise<Sync> {
  const params: Stripe.DisputeListParams = { limit: 100 }
  if (created) params.created = created

  let synced = 0
  for await (const dispute of stripe.disputes.list(params)) {
    await upsertDisputes([dispute])
    synced++
  }

  return { synced }
}
