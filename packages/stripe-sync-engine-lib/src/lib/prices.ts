import Stripe from 'stripe'
import { backfillProducts } from './products'
import { priceSchema } from '../schemas/price'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'

export const upsertPrices = async (
  prices: Stripe.Price[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.Price[]> => {
  if (backfillRelatedEntities) {
    await backfillProducts(getUniqueIds(prices, 'product'), pgClient, stripe)
  }

  return pgClient.upsertMany(prices, 'prices', priceSchema)
}

export const deletePrice = async (id: string, pgClient: PostgresClient): Promise<boolean> => {
  return pgClient.deleteOne('prices', id)
}
