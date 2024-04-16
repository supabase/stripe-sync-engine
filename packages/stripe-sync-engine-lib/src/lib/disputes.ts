import Stripe from 'stripe'
import { backfillCharges } from './charges'
import { disputeSchema } from '../schemas/dispute'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'
import { ConfigType } from '../types/types'

export const upsertDisputes = async (
  disputes: Stripe.Dispute[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Dispute[]> => {
  if (backfillRelatedEntities) {
    await backfillCharges(getUniqueIds(disputes, 'charge'), pgClient, stripe, config)
  }

  return pgClient.upsertMany(disputes, 'disputes', disputeSchema)
}
