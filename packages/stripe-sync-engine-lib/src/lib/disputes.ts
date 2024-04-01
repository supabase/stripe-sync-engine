import Stripe from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCharges } from './charges'
import { disputeSchema } from '../schemas/dispute'
import { getUniqueIds, upsertMany } from './database_utils'

const config = getConfig()

export const upsertDisputes = async (
  disputes: Stripe.Dispute[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Dispute[]> => {
  if (backfillRelatedEntities) {
    await backfillCharges(getUniqueIds(disputes, 'charge'))
  }

  return upsertMany(disputes, () => constructUpsertSql(config.SCHEMA, 'disputes', disputeSchema))
}
