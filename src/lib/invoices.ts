import Invoice from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { invoiceSchema } from '../schemas/invoice'
import { verifyCustomerExists, fetchAndInsertCustomer } from './customers'
import { verifySubscriptionExists, fetchAndInsertSubscription } from './subscriptions'

const config = getConfig()

export const upsertInvoice = async (invoice: Invoice.Invoice): Promise<Invoice.Invoice[]> => {
  // Backfill customer if it doesn't already exist
  const customerId = invoice?.customer?.toString()
  if (customerId && !(await verifyCustomerExists(customerId))) {
    await fetchAndInsertCustomer(customerId)
  }

  // Backfill subscription if it doesn't already exist
  const subscriptionId = invoice?.subscription?.toString()
  if (subscriptionId && !(await verifySubscriptionExists(subscriptionId))) {
    await fetchAndInsertSubscription(subscriptionId)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'invoices', invoiceSchema)

  // Inject the values
  const prepared = sql(upsertString)(invoice)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifyInvoiceExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."invoices" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertInvoice = async (id: string): Promise<Invoice.Invoice[]> => {
  const invoice = await stripe.invoices.retrieve(id)
  return upsertInvoice(invoice)
}
