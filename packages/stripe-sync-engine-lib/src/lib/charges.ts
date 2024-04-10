import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { chargeSchema } from '../schemas/charge'
import { backfillInvoices } from './invoices'
import { backfillCustomers } from './customers'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertCharges = async (
  charges: Stripe.Charge[],
  backfillRelatedEntities: boolean = true,
  config: ConfigType
): Promise<Stripe.Charge[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(charges, 'customer'), config),
      backfillInvoices(getUniqueIds(charges, 'invoice'), config),
    ])
  }

  // Stripe only sends the first 10 refunds by default, the option will actively fetch all refunds
  if (config.AUTO_EXPAND_LISTS) {
    for (const charge of charges) {
      if (charge.refunds?.has_more) {
        const allRefunds: Stripe.Refund[] = []
        for await (const refund of getStripe(config).refunds.list({
          charge: charge.id,
          limit: 100,
        })) {
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

  return upsertMany(
    charges,
    () => constructUpsertSql(config.SCHEMA, 'charges', chargeSchema),
    config.DATABASE_URL
  )
}

export const backfillCharges = async (chargeIds: string[], config: ConfigType) => {
  const missingChargeIds = await findMissingEntries('charges', chargeIds, config)
  await fetchAndInsertCharges(missingChargeIds, config)
}

const fetchAndInsertCharges = async (chargeIds: string[], config: ConfigType) => {
  if (!chargeIds.length) return

  const charges: Stripe.Charge[] = []

  for (const chargeId of chargeIds) {
    const charge = await getStripe(config).charges.retrieve(chargeId)
    charges.push(charge)
  }

  await upsertCharges(charges, true, config)
}
