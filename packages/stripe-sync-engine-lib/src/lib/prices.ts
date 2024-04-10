import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { backfillProducts } from './products'
import { constructUpsertSql } from '../utils/helpers'
import { priceSchema } from '../schemas/price'
import { getUniqueIds, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'

export const upsertPrices = async (
  prices: Stripe.Price[],
  backfillRelatedEntities: boolean = true,
  config: ConfigType
): Promise<Stripe.Price[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(prices, 'product'), config)
  }

  return upsertMany(
    prices,
    () => constructUpsertSql(config.SCHEMA, 'prices', priceSchema),
    config.DATABASE_URL
  )
}

export const deletePrice = async (id: string, config: ConfigType): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."prices" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, config.DATABASE_URL, prepared.values)
  return rows.length > 0
}
