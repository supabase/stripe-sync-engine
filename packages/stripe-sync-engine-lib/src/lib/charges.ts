import Stripe from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { chargeSchema } from '../schemas/charge'
import { backfillInvoices } from './invoices'
import { backfillCustomers } from './customers'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import { stripe } from '../utils/StripeClientManager'

const config = getConfig()

export const upsertCharges = async (
  charges: Stripe.Charge[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Charge[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(charges, 'customer')),
      backfillInvoices(getUniqueIds(charges, 'invoice')),
    ])
  }

  // Stripe only sends the first 10 refunds by default, the option will actively fetch all refunds
  if (getConfig().AUTO_EXPAND_LISTS) {
    for (const charge of charges) {
      if (charge.refunds?.has_more) {
        const allRefunds: Stripe.Refund[] = []
        for await (const refund of stripe.refunds.list({ charge: charge.id, limit: 100 })) {
          allRefunds.push(refund)
        }

        charge.refunds = {
          ...charge.refunds,
          data: allRefunds,
          has_more: false,
        }
      }
    }
  }

  return upsertMany(charges, () => constructUpsertSql(config.SCHEMA, 'charges', chargeSchema))
}

export const backfillCharges = async (chargeIds: string[]) => {
  const missingChargeIds = await findMissingEntries('charges', chargeIds)
  await fetchAndInsertCharges(missingChargeIds)
}

const fetchAndInsertCharges = async (chargeIds: string[]) => {
  if (!chargeIds.length) return

  const charges: Stripe.Charge[] = []

  for (const chargeId of chargeIds) {
    const charge = await stripe.charges.retrieve(chargeId)
    charges.push(charge)
  }

  await upsertCharges(charges, true)
}
