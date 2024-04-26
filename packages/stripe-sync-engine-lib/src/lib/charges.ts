import Stripe from 'stripe'
import { chargeSchema } from '../schemas/charge'
import { backfillInvoices } from './invoices'
import { backfillCustomers } from './customers'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'
import { ConfigType } from '../types/types'

export const upsertCharges = async (
  charges: Stripe.Charge[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Charge[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(charges, 'customer'), pgClient, stripe),
      backfillInvoices(getUniqueIds(charges, 'invoice'), pgClient, stripe, config),
    ])
  }

  // Stripe only sends the first 10 refunds by default, the option will actively fetch all refunds
  if (config.AUTO_EXPAND_LISTS) {
    for (const charge of charges) {
      if (charge.refunds?.has_more) {
        const allRefunds: Stripe.Refund[] = []
        for await (const refund of stripe.refunds.list({
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

  return pgClient.upsertMany(charges, 'charges', chargeSchema)
}

export const backfillCharges = async (
  chargeIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType
) => {
  const missingChargeIds = await pgClient.findMissingEntries('charges', chargeIds)
  await fetchAndInsertCharges(missingChargeIds, pgClient, stripe, config)
}

const fetchAndInsertCharges = async (
  chargeIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType
) => {
  if (!chargeIds.length) return

  const charges: Stripe.Charge[] = []

  for (const chargeId of chargeIds) {
    const charge = await stripe.charges.retrieve(chargeId)
    charges.push(charge)
  }

  await upsertCharges(charges, pgClient, stripe, config)
}
