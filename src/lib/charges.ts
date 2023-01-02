import Stripe from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { chargeSchema } from '../schemas/charge'
import { backfillInvoices } from './invoices'
import { backfillCustomers } from './customers'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import { stripe } from '../utils/StripeClientManager'

const config = getConfig()

export const upsertCharges = async (charges: Stripe.Charge[]): Promise<Stripe.Charge[]> => {
  // Backfill customer if it doesn't already exist
  await backfillCustomers(getUniqueIds(charges, 'customer'))

  // Backfill invoice if it doesn't already exist
  await backfillInvoices(getUniqueIds(charges, 'invoice'))

  return upsertMany(charges, () =>
    constructUpsertSql(config.SCHEMA || 'stripe', 'charges', chargeSchema)
  )
}

export const backfillCharges = async (chargeIds: string[]) => {
  const missingCustomerIds = await findMissingEntries('charges', chargeIds)
  await fetchAndInsertCharges(missingCustomerIds)
}

export const fetchAndInsertCharges = async (chargeIds: string[]) => {
  if (!chargeIds.length) return

  const charges: Stripe.Charge[] = []

  for (const chargeId of chargeIds) {
    const charge = await stripe.charges.retrieve(chargeId)
    charges.push(charge)
  }

  await upsertCharges(charges)
}
