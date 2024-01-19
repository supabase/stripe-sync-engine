import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { backfillProducts } from './products'
import { constructUpsertSql } from '../utils/helpers'
import { getUniqueIds, upsertMany } from './database_utils'
import { planSchema } from '../schemas/plan'

const config = getConfig()

export const upsertPlans = async (
  plans: Stripe.Plan[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Plan[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(plans, 'product'))
  }

  return upsertMany(plans, () => constructUpsertSql(config.SCHEMA, 'plans', planSchema))
}

export const deletePlan = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."plans" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}
