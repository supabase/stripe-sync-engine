import Stripe from 'stripe'
import { expandEntity } from '../utils/expandEntity'

export async function expandLists(opts: {
  items: Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  listExpands: Record<string, (id: string) => Promise<Stripe.ApiList<{ id?: string }>>>[]
}): Promise<void> {
  for (const expandEntry of opts.listExpands) {
    for (const [property, expandFn] of Object.entries(expandEntry)) {
      await expandEntity(opts.items, property, (id) => expandFn(id))
    }
  }
}
