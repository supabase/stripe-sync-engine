import Invoice from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { invoiceSchema } from '../schemas/invoice'
import { backfillCustomers } from './customers'
import { backfillSubscriptions } from './subscriptions'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { stripe } from '../utils/StripeClientManager'

const config = getConfig()

export const upsertInvoices = async (invoices: Invoice.Invoice[]): Promise<Invoice.Invoice[]> => {
  await Promise.all([
    backfillCustomers(getUniqueIds(invoices, 'customer')),
    backfillSubscriptions(getUniqueIds(invoices, 'subscription')),
  ])

  return upsertMany(invoices, () =>
    constructUpsertSql(config.SCHEMA || 'stripe', 'invoices', invoiceSchema)
  )
}

export const backfillInvoices = async (invoiceIds: string[]) => {
  const missingInvoiceIds = await findMissingEntries('invoices', invoiceIds)
  await fetchAndInsertInvoices(missingInvoiceIds)
}

const fetchAndInsertInvoices = async (invoiceIds: string[]) => {
  if (!invoiceIds.length) return

  const invoices: Stripe.Invoice[] = []

  for (const invoiceId of invoiceIds) {
    const invoice = await stripe.invoices.retrieve(invoiceId)
    invoices.push(invoice)
  }

  await upsertInvoices(invoices)
}
