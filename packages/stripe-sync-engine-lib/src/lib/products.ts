import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { productSchema } from '../schemas/product'
import { constructUpsertSql } from '../utils/helpers'
import { findMissingEntries, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertProducts = async (
  products: Stripe.Product[],
  config: ConfigType
): Promise<Stripe.Product[]> => {
  return upsertMany(
    products,
    () => constructUpsertSql(config.SCHEMA, 'products', productSchema),
    config.DATABASE_URL
  )
}

export const deleteProduct = async (id: string, config: ConfigType): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."products" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, config.DATABASE_URL, prepared.values)
  return rows.length > 0
}

export const backfillProducts = async (productids: string[], config: ConfigType) => {
  const missingProductIds = await findMissingEntries('products', productids, config)
  await fetchAndInsertProducts(missingProductIds, config)
}

const fetchAndInsertProducts = async (productIds: string[], config: ConfigType) => {
  if (!productIds.length) return

  const products: Stripe.Product[] = []

  for (const productId of productIds) {
    const product = await getStripe(config).products.retrieve(productId)
    products.push(product)
  }

  await upsertProducts(products, config)
}
