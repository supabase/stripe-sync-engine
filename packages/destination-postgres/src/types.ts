import { PoolConfig } from 'pg'

export type PostgresConfig = {
  schema: string
  /** Schema for metadata tables (accounts, _sync_runs, etc.). Defaults to schema when not provided. */
  syncSchema?: string
  poolConfig: PoolConfig
  /** Number of records to buffer before flushing to the database. Default: 100. */
  batchSize?: number
}

export type RawJsonUpsertOptions = {
  /**
   * Columns to use as the ON CONFLICT target.
   * Example: ['id'] for standard Stripe objects, or a composite key for Sigma tables.
   */
  conflictTarget: string[]

  /**
   * Additional typed columns to insert alongside `_raw_data` (for tables that don't have `id` keys).
   * Values are read from `entry[entryKey]` and cast to `pgType` in SQL.
   */
  extraColumns?: Array<{ column: string; pgType: string; entryKey: string }>
}

//todo: move them into migrations. also think about what should be done with ORDERED_STRIPE_TABLES.
export const METADATA_TABLES = new Set([
  'accounts',
  '_managed_webhooks',
  '_sync_runs',
  '_sync_obj_runs',
])
