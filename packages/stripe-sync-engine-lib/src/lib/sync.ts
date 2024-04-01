import Stripe from 'stripe'

interface Sync {
  synced: number
}

interface SyncBackfill {
  products?: Sync
  prices?: Sync
  plans?: Sync

  customers?: Sync
  subscriptions?: Sync
  subscriptionSchedules?: Sync
  invoices?: Sync

  setupIntents?: Sync
  paymentIntents?: Sync
  paymentMethods?: Sync

  disputes?: Sync
  charges?: Sync
  taxIds?: Sync
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam

  object?: SyncObject
  backfillRelatedEntities?: boolean
}

type SyncObject =
  | 'all'
  | 'customer'
  | 'invoice'
  | 'price'
  | 'product'
  | 'subscription'
  | 'subscription_schedules'
  | 'setup_intent'
  | 'payment_method'
  | 'dispute'
  | 'charge'
  | 'payment_intent'
  | 'plan'
  | 'tax_id'

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
  backfillRelatedEntities?: boolean
}

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
  console.log('syncBackfill')
  console.log(params)
  return {}
}
