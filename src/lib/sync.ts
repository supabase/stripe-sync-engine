import { upsertProduct } from './products'
import { upsertPrice } from './prices'
import { upsertSubscription } from './subscriptions'
import { upsertInvoice } from './invoices'
import { upsertCustomer } from './customers'
import { stripe } from '../utils/StripeClientManager'
import Stripe from 'stripe'

interface SyncResponse {
  synced: number
}

interface SyncBackfillResponse {
  products: SyncResponse
  prices: SyncResponse
  customers: SyncResponse
  subscriptions: SyncResponse
  invoices: SyncResponse
}
export async function syncBackfill(gteCreated?: number): Promise<SyncBackfillResponse> {
  const products = await syncProducts(gteCreated)
  const prices = await syncPrices(gteCreated)
  const customers = await syncCustomers(gteCreated)
  const subscriptions = await syncSubscriptions(gteCreated)
  const invoices = await syncInvoices(gteCreated)
  return {
    products,
    prices,
    customers,
    subscriptions,
    invoices,
  }
}

export async function syncProducts(gteCreated?: number): Promise<SyncResponse> {
  const params: Stripe.ProductListParams = { limit: 100 }
  if (gteCreated) {
    params.created = { gte: gteCreated }
  }

  let synced = 0
  for await (const product of stripe.products.list(params)) {
    await upsertProduct(product)
    synced++
  }

  return { synced }
}

export async function syncPrices(gteCreated?: number): Promise<SyncResponse> {
  const params: Stripe.PriceListParams = { limit: 100 }
  if (gteCreated) {
    params.created = { gte: gteCreated }
  }

  let synced = 0
  for await (const price of stripe.prices.list(params)) {
    await upsertPrice(price)
    synced++
  }

  return { synced }
}

export async function syncCustomers(gteCreated?: number): Promise<SyncResponse> {
  const params: Stripe.CustomerListParams = { limit: 100 }
  if (gteCreated) {
    params.created = { gte: gteCreated }
  }

  let synced = 0
  for await (const customer of stripe.customers.list(params)) {
    await upsertCustomer(customer)
    synced++
  }

  return { synced }
}

export async function syncSubscriptions(gteCreated?: number): Promise<SyncResponse> {
  const params: Stripe.SubscriptionListParams = { status: 'all', limit: 100 }
  if (gteCreated) {
    params.created = { gte: gteCreated }
  }

  let synced = 0
  for await (const subscription of stripe.subscriptions.list(params)) {
    await upsertSubscription(subscription)
    synced++
  }

  return { synced }
}

export async function syncInvoices(gteCreated?: number): Promise<SyncResponse> {
  const params: Stripe.InvoiceListParams = { limit: 100 }
  if (gteCreated) {
    params.created = { gte: gteCreated }
  }

  let synced = 0
  for await (const invoice of stripe.invoices.list(params)) {
    await upsertInvoice(invoice)
    synced++
  }

  return { synced }
}
