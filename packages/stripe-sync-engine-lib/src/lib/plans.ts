import Stripe from 'stripe'
import { backfillProducts } from './products'
import { planSchema } from '../schemas/plan'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'

export const upsertPlans = async (
  plans: Stripe.Plan[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Plan[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(plans, 'product'), pgClient, stripe)
  }

  return pgClient.upsertMany(plans, 'plans', planSchema)
}

export const deletePlan = async (id: string, pgClient: PostgresClient): Promise<boolean> => {
  return pgClient.deleteOne('plans', id)
}
