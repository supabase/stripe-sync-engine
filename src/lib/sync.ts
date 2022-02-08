import { upsertProduct } from './products'
import { upsertPrice } from './prices'
import { upsertSubscription } from './subscriptions'
import { upsertInvoice } from './invoices'
import { upsertCustomer } from './customers'
import { stripe } from '../utils/StripeClientManager'

export async function syncProducts(): Promise<{ synced: number }> {
  let synced = 0
  for await (const product of stripe.products.list({ limit: 100 })) {
    await upsertProduct(product)
    synced++
  }

  return { synced }
}

export async function syncPrices(): Promise<{ synced: number }> {
  let synced = 0
  for await (const price of stripe.prices.list({ limit: 100 })) {
    await upsertPrice(price)
    synced++
  }

  return { synced }
}

export async function syncSubscriptions(): Promise<{ synced: number }> {
  let synced = 0
  for await (const subscription of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
    await upsertSubscription(subscription)
    synced++
  }

  return { synced }
}

export async function syncCustomers(): Promise<{ synced: number }> {
  let synced = 0
  for await (const customer of stripe.customers.list({ limit: 100 })) {
    await upsertCustomer(customer)
    synced++
  }

  return { synced }
}

export async function syncInvoices(): Promise<{ synced: number }> {
  let synced = 0
  for await (const invoice of stripe.invoices.list({ limit: 100 })) {
    await upsertInvoice(invoice)
    synced++
  }

  return { synced }
}
