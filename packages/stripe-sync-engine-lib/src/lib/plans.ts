import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { backfillProducts } from './products'
import { constructUpsertSql } from '../utils/helpers'
import { getUniqueIds, upsertMany } from './database_utils'
import { planSchema } from '../schemas/plan'
import { ConfigType } from '../types/types'

export const upsertPlans = async (
  plans: Stripe.Plan[],
  backfillRelatedEntities: boolean = true,
  config: ConfigType
): Promise<Stripe.Plan[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(plans, 'product'), config)
  }

  return upsertMany(
    plans,
    () => constructUpsertSql(config.SCHEMA, 'plans', planSchema),
    config.DATABASE_URL
  )
}

export const deletePlan = async (id: string, config: ConfigType): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."plans" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, config.DATABASE_URL, prepared.values)
  return rows.length > 0
}
