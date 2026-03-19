// Sync Engine -- Sync Resource Types
//
// The Sync resource unifies source config, destination config,
// stream selection, status, and checkpoint state into a single
// first-class object. See v2/docs/3-sync/sync-types.ts for the
// full v2 spec; this file contains the subset relevant to the
// current engine.

/** Runtime status of a sync. Managed by the orchestrator. */
export type SyncStatus = 'backfilling' | 'syncing' | 'paused' | 'error'

/** Per-stream configuration. */
export interface StreamConfig {
  /** Stream name (e.g. "customers", "invoices"). */
  name: string
  /** 'incremental' (default) or 'full_refresh'. */
  sync_mode?: 'incremental' | 'full_refresh'
  /** Skip historical backfill, only sync new events going forward. */
  skip_backfill?: boolean
}

/** Source configuration -- Stripe core API variant (only source today). */
export interface StripeApiCoreSource {
  type: 'stripe-api-core'
  livemode: boolean
  api_version: string
  /** Opaque reference to a credential. In v1 this is the API key hash. */
  credential_id: string
}

/** Source configuration union (extensible). */
export type SourceConfig = StripeApiCoreSource

/** Destination configuration -- Postgres variant (only destination today). */
export interface PostgresDestination {
  type: 'postgres'
  schema_name: string
  /** Opaque reference to a credential. In v1 this is derived from the pool config. */
  credential_id: string
}

/** Destination configuration union (extensible). */
export type DestinationConfig = PostgresDestination

/**
 * A Sync is the full resource -- configuration + runtime state.
 * The user sets source, destination, and streams.
 * The orchestrator manages status and state.
 *
 * Analogous to Airbyte's Connection (config + configured catalog + state).
 */
export interface Sync {
  id: `sync_${string}`
  account_id: `acct_${string}`

  /** Runtime status. Managed by the orchestrator. */
  status: SyncStatus

  /** Where data comes from. */
  source: SourceConfig

  /** Where data goes. */
  destination: DestinationConfig

  /**
   * Which streams to sync and per-stream options.
   * If omitted, sync all streams discovered by the source.
   */
  streams?: StreamConfig[]

  /**
   * Per-stream checkpoint map. Managed by the orchestrator.
   * Keyed by stream name, values are opaque to everything except the source.
   */
  state?: Record<string, unknown>
}
