import { productSchema } from '../schemas/product'
import Stripe from 'stripe'
import { PostgresClient } from '../database/postgres'

export const upsertProducts = async (
  products: Stripe.Product[],
  pgClient: PostgresClient
): Promise<Stripe.Product[]> => {
  return pgClient.upsertMany(products, 'products', productSchema)
}

export const deleteProduct = async (id: string, pgClient: PostgresClient): Promise<boolean> => {
  return pgClient.deleteOne('products', id)
}

export const backfillProducts = async (
  productids: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  const missingProductIds = await pgClient.findMissingEntries('products', productids)
  await fetchAndInsertProducts(missingProductIds, pgClient, stripe)
}

const fetchAndInsertProducts = async (
  productIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  if (!productIds.length) return

  const products: Stripe.Product[] = []

  for (const productId of productIds) {
    const product = await stripe.products.retrieve(productId)
    products.push(product)
  }

  await upsertProducts(products, pgClient)
}
