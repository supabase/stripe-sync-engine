import Stripe from 'stripe'

/**
 * Syncable resource configuration
 */
export type BaseResourceConfig = {
  /** Backfill order: lower numbers sync first; parents before children for FK dependencies */
  order: number
  /** Database table name for this resource (e.g. 'customers', 'invoices') */
  tableName: string
  /** Whether this resource supports incremental sync via 'created' filter or cursor */
  supportsCreatedFilter: boolean
  /** Whether this resource is included in sync runs by default. Default: true */
  sync?: boolean
  /** Resource types that must be backfilled before this one (e.g. price depends on product) */
  dependencies?: readonly string[]
  /** Function to check if an entity is in a final state and doesn't need revalidation */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isFinalState?: (entity: any) => boolean
}

export type StripeListResourceConfig = BaseResourceConfig & {
  /** Function to list items from Stripe API */
  listFn: (params: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam }) => Promise<{
    data: unknown[]
    has_more: boolean
  }>
  /** Function to retrieve a single item by ID from Stripe API */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retrieveFn: (id: string) => Promise<Stripe.Response<any>>
  /** Optional list of sub-resources to expand during upsert/fetching (e.g. 'refunds', 'listLineItems') */
  listExpands?: Record<string, (id: string) => Promise<Stripe.ApiList<{ id?: string }>>>[]
  /** discriminator */
  sigma?: undefined
}

/** Union of all resource configuration types (Sigma excluded — lives in sync-engine) */
export type ResourceConfig = StripeListResourceConfig
