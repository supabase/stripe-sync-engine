import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { productSchema } from '../schemas/product'
import { constructUpsertSql } from '../utils/helpers'
import { findMissingEntries, upsertMany } from './database_utils'
import Stripe from 'stripe'

const config = getConfig()

export const upsertProducts = async (products: Stripe.Product[]): Promise<Stripe.Product[]> => {
  return upsertMany(products, () => constructUpsertSql(config.SCHEMA, 'products', productSchema))
}

export const deleteProduct = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."products" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const backfillProducts = async (productids: string[]) => {
  const missingProductIds = await findMissingEntries('products', productids)
  await fetchAndInsertProducts(missingProductIds)
}

const fetchAndInsertProducts = async (productIds: string[]) => {
  if (!productIds.length) return

  const products: Stripe.Product[] = []

  for (const productId of productIds) {
    const product = await stripe.products.retrieve(productId)
    products.push(product)
  }

  await upsertProducts(products)
}
