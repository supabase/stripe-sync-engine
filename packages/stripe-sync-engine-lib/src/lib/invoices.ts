import { constructUpsertSql } from '../utils/helpers'
import { invoiceSchema } from '../schemas/invoice'
import { backfillCustomers } from './customers'
import { backfillSubscriptions } from './subscriptions'

import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertInvoices = async (
  invoices: Stripe.Invoice[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Invoice[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(invoices, 'customer'), config),
      backfillSubscriptions(getUniqueIds(invoices, 'subscription'), config),
    ])
  }

  // Stripe only sends the first 10 line items by default, the option will actively fetch all line items
  if (config.AUTO_EXPAND_LISTS) {
    for (const invoice of invoices) {
      if (invoice.lines.has_more) {
        const allLineItems: Stripe.InvoiceLineItem[] = []
        for await (const lineItem of getStripe(config).invoices.listLineItems(invoice.id, {
          limit: 100,
        })) {
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

  return upsertMany(
    invoices,
    () => constructUpsertSql(config.SCHEMA, 'invoices', invoiceSchema),
    config.DATABASE_URL
  )
}

export const backfillInvoices = async (invoiceIds: string[], config: ConfigType) => {
  const missingInvoiceIds = await findMissingEntries('invoices', invoiceIds, config)
  await fetchAndInsertInvoices(missingInvoiceIds, config)
}

const fetchAndInsertInvoices = async (invoiceIds: string[], config: ConfigType) => {
  if (!invoiceIds.length) return

  const invoices: Stripe.Invoice[] = []

  for (const invoiceId of invoiceIds) {
    const invoice = await getStripe(config).invoices.retrieve(invoiceId)
    invoices.push(invoice)
  }

  await upsertInvoices(invoices, config)
}
