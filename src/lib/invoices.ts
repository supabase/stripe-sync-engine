import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { invoiceSchema } from '../schemas/invoice'
import { backfillCustomers } from './customers'
import { backfillSubscriptions } from './subscriptions'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { stripe } from '../utils/StripeClientManager'

const config = getConfig()

export const upsertInvoices = async (
  invoices: Stripe.Invoice[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Invoice[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(invoices, 'customer')),
      backfillSubscriptions(getUniqueIds(invoices, 'subscription')),
    ])
  }

  // Stripe only sends the first 10 line items by default, the option will actively fetch all line items
  if (getConfig().AUTO_EXPAND_LISTS) {
    for (const invoice of invoices) {
      if (invoice.lines.has_more) {
        const allLineItems: Stripe.InvoiceLineItem[] = []
        for await (const lineItem of stripe.invoices.listLineItems(invoice.id, { limit: 100 })) {
          allLineItems.push(lineItem)
        }

        invoice.lines = {
          ...invoice.lines,
          data: allLineItems,
          has_more: false,
        }
      }
    }
  }

  return upsertMany(invoices, () => constructUpsertSql(config.SCHEMA, 'invoices', invoiceSchema))
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
