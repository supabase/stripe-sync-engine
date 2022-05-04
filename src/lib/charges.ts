import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { cleanseArrayField, constructUpsertSql } from '../utils/helpers'
import { chargeSchema } from '../schemas/charge'
import { fetchAndInsertCustomer, verifyCustomerExists } from './customers'
import { fetchAndInsertInvoice, verifyInvoiceExists } from './invoices'

const config = getConfig()

export const upsertCharge = async (charge: Stripe.Charge): Promise<Stripe.Charge[]> => {
  // Backfill customer if it doesn't already exist
  const customerId = charge?.customer?.toString()
  if (customerId && !(await verifyCustomerExists(customerId))) {
    await fetchAndInsertCustomer(customerId)
  }
  // Backfill invoice if it doesn't already exist
  const invoiceId = charge?.invoice?.toString()
  if (invoiceId && !(await verifyInvoiceExists(invoiceId))) {
    await fetchAndInsertInvoice(invoiceId)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'charges', chargeSchema)

  // Inject the values
  const cleansed = cleanseArrayField(charge)
  const prepared = sql(upsertString)(cleansed)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifyChargeExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."charges" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertCharge = async (id: string): Promise<Stripe.Charge[]> => {
  const charge = await stripe.charges.retrieve(id)
  return upsertCharge(charge)
}
