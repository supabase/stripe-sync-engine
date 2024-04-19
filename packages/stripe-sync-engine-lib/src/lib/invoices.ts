import { invoiceSchema } from '../schemas/invoice'
import { backfillCustomers } from './customers'
import { backfillSubscriptions } from './subscriptions'

import Stripe from 'stripe'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'
import { ConfigType } from '../types/types'

export const upsertInvoices = async (
  invoices: Stripe.Invoice[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Invoice[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(invoices, 'customer'), pgClient, stripe),
      backfillSubscriptions(getUniqueIds(invoices, 'subscription'), pgClient, stripe, config),
    ])
  }

  // Stripe only sends the first 10 line items by default, the option will actively fetch all line items
  if (config.AUTO_EXPAND_LISTS) {
    for (const invoice of invoices) {
      if (invoice.lines.has_more) {
        const allLineItems: Stripe.InvoiceLineItem[] = []
        for await (const lineItem of stripe.invoices.listLineItems(invoice.id, {
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

  return pgClient.upsertMany(invoices, 'invoices', invoiceSchema)
}

export const backfillInvoices = async (
  invoiceIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType
) => {
  const missingInvoiceIds = await pgClient.findMissingEntries('invoices', invoiceIds)
  await fetchAndInsertInvoices(missingInvoiceIds, pgClient, stripe, config)
}

const fetchAndInsertInvoices = async (
  invoiceIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType
) => {
  if (!invoiceIds.length) return

  const invoices: Stripe.Invoice[] = []

  for (const invoiceId of invoiceIds) {
    const invoice = await stripe.invoices.retrieve(invoiceId)
    invoices.push(invoice)
  }

  await upsertInvoices(invoices, pgClient, stripe, config)
}
