import Stripe from 'stripe'

/**
 * Stripe only sends the first 10 entries by default, the option will actively fetch all entries.
 * Uses manual pagination - each fetch() gets automatic retry protection.
 */
export async function expandEntity<
  K extends { id?: string },
  P extends keyof T,
  T extends { id?: string } & { [key in P]?: Stripe.ApiList<K> | null },
>(
  entities: T[],
  property: P,
  listFn: (id: string, params?: { starting_after?: string }) => Promise<Stripe.ApiList<K>>
) {
  for (const entity of entities) {
    const existingList = entity[property]
    if (!existingList || existingList.has_more) {
      const allData: K[] = []

      // Manual pagination - each fetch() gets automatic retry protection
      let hasMore = true
      let startingAfter: string | undefined = undefined

      while (hasMore) {
        const response = await listFn(
          entity.id!,
          startingAfter ? { starting_after: startingAfter } : undefined
        )

        allData.push(...response.data)

        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
      }

      entity[property] = {
        ...existingList,
        object: 'list',
        data: allData,
        has_more: false,
      } as T[P]
    }
  }
}
