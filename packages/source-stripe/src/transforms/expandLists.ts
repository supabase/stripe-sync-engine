import type { StripeApiList } from '@stripe/sync-openapi'
import { expandEntity } from '../utils/expandEntity.js'

export async function expandLists(opts: {
  items: Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  listExpands: Record<string, (id: string) => Promise<StripeApiList<{ id?: string }>>>[]
}): Promise<void> {
  for (const expandEntry of opts.listExpands) {
    for (const [property, expandFn] of Object.entries(expandEntry)) {
      await expandEntity(opts.items, property, (id) => expandFn(id))
    }
  }
}
