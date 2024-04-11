import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCharges } from './charges'
import { disputeSchema } from '../schemas/dispute'
import { getUniqueIds, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'

export const upsertDisputes = async (
  disputes: Stripe.Dispute[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Dispute[]> => {
  if (backfillRelatedEntities) {
    await backfillCharges(getUniqueIds(disputes, 'charge'), config)
  }

  return upsertMany(
    disputes,
    () => constructUpsertSql(config.SCHEMA, 'disputes', disputeSchema),
    config.DATABASE_URL
  )
}
