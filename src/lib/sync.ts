import { fetchProducts, upsertProduct } from './products'

export async function syncProducts(): Promise<{ synced: number; lastId: string }> {
  let hasMore = true
  let synced = 0
  let lastId = ''

  while (hasMore) {
    const productChunk = await fetchProducts()
    const products = productChunk.data
    await Promise.all(products.map((x) => upsertProduct(x)))
    synced += products.length
    lastId += products[products.length - 1].id
    hasMore = productChunk.has_more
  }

  return { synced, lastId }
}
