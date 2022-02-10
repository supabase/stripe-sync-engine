import { upsertProduct } from './products'
import { upsertPrice } from './prices'
import { upsertSubscription } from './subscriptions'
import { upsertInvoice } from './invoices'
import { upsertCustomer } from './customers'
import { stripe } from '../utils/StripeClientManager'
import Stripe from 'stripe'

interface Sync {
  synced: number
}

interface SyncBackfill {
  products?: Sync
  prices?: Sync
  customers?: Sync
  subscriptions?: Sync
  invoices?: Sync
}

export interface SyncBackfillParams {
  gteCreated?: number
  object?: SyncBackfillParams.Object
}

namespace SyncBackfillParams {
  export type Object = 'all' | 'customer' | 'invoice' | 'price' | 'product' | 'subscription'
}

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
  let { gteCreated, object } = params ?? {}
  let products, prices, customers, subscriptions, invoices

  switch (object) {
    case 'all':
      products = await syncProducts(gteCreated)
      prices = await syncPrices(gteCreated)
      customers = await syncCustomers(gteCreated)
      subscriptions = await syncSubscriptions(gteCreated)
      invoices = await syncInvoices(gteCreated)
      break
    case 'customer':
      customers = await syncCustomers(gteCreated)
      break
    case 'invoice':
      invoices = await syncInvoices(gteCreated)
      break
    case 'price':
      prices = await syncPrices(gteCreated)
      break
    case 'product':
      products = await syncProducts(gteCreated)
      break
    case 'subscription':
      subscriptions = await syncSubscriptions(gteCreated)
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
  }
}

export async function syncProducts(gteCreated?: number): Promise<Sync> {
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

export async function syncPrices(gteCreated?: number): Promise<Sync> {
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

export async function syncCustomers(gteCreated?: number): Promise<Sync> {
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

export async function syncSubscriptions(gteCreated?: number): Promise<Sync> {
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

export async function syncInvoices(gteCreated?: number): Promise<Sync> {
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
