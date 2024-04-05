import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { backfillProducts } from './products'
import { constructUpsertSql } from '../utils/helpers'
import { priceSchema } from '../schemas/price'
import { getUniqueIds, upsertMany } from './database_utils'

const config = getConfig()

export const upsertPrices = async (
  prices: Stripe.Price[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Price[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(prices, 'product'))
  }

  return upsertMany(prices, () => constructUpsertSql(config.SCHEMA, 'prices', priceSchema))
}

export const deletePrice = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."prices" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}
