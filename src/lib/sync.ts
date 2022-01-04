import { fetchProducts, upsertProduct } from './products'
import { fetchPrices, upsertPrice } from './prices'

export async function syncProducts(): Promise<{ synced: number; lastId: string }> {
  let hasMore = true
  let synced = 0
  let lastId = ''

  while (hasMore) {
    const chunk = await fetchProducts()
    const data = chunk.data
    await Promise.all(data.map((x) => upsertProduct(x)))
    synced += data.length
    lastId += data[data.length - 1].id
    hasMore = chunk.has_more
  }

  return { synced, lastId }
}

export async function syncPrices(): Promise<{ synced: number; lastId: string }> {
  let hasMore = true
  let synced = 0
  let lastId = ''

  while (hasMore) {
    const chunk = await fetchPrices()
    const data = chunk.data
    await Promise.all(data.map((x) => upsertPrice(x)))
    synced += data.length
    lastId += data[data.length - 1].id
    hasMore = chunk.has_more
  }

  return { synced, lastId }
}
