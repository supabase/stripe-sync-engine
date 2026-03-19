// MARK: - Secrets vault

export type CredentialConfig =
  | {
      type: 'postgres'
      host: string
      port: number
      user: string
      password: string
      database: string
    }
  | {
      type: 'google'
      client_id: string
      client_secret: string
      refresh_token?: string
    }
  | {
      type: 'stripe'
      api_key: string
    }
export type Credential = { id: `cred_${string}`; account_id: `acct_${string}` } & CredentialConfig

// MARK: - Config database

export type StripeApiVersion =
  | '2025-04-30.basil'
  | '2025-03-31.basil'
  | '2024-12-18.acacia'
  | '2024-11-20.acacia'
  | '2024-10-28.acacia'
  | '2024-09-30.acacia'

export type SourceConfig =
  /** Pull via Stripe's core REST API. Requires a credential with a Stripe API key. */
  | {
      type: 'stripe-api-core'
      livemode: boolean
      api_version: StripeApiVersion
      credential_id: string
    }
  /** Pull via Stripe's Reporting API. Requires a credential with a Stripe API key. */
  | {
      type: 'stripe-api-reporting'
      livemode: boolean
      api_version: StripeApiVersion
      credential_id: string
    }
  /** Receive events via Stripe EventBridge. No credential needed — uses account-level access. */
  | { type: 'stripe-event-bridge'; livemode: boolean; account_id: `acct_${string}` }

export type DestinationConfig =
  | {
      type: 'postgres'
      schema_name: string
      /** Credential type: `postgres` */
      credential_id: string
    }
  | {
      type: 'google-sheets'
      google_sheet_id: string
      /** Credential type: `google` */
      credential_id: string
    }
  | {
      type: 'stripe-database'
      database_id: `db_${string}`
    }

export type SyncStatus = 'backfilling' | 'syncing' | 'paused' | 'error'

export interface StreamConfig {
  /** Stream name (e.g. "customers", "invoices"). */
  name: string
  /** 'incremental' (default) or 'full_refresh'. */
  sync_mode?: 'incremental' | 'full_refresh'
  /** Skip historical backfill, only sync new events going forward. */
  skip_backfill?: boolean
}

/**
 * A Sync is the full resource — configuration + runtime state.
 * The user sets source, destination, and streams.
 * The orchestrator manages status and state.
 *
 * Analogous to Airbyte's Connection (config + configured catalog + state).
 */
export type Sync = {
  id: `sync_${string}`
  account_id: `acct_${string}`

  // Runtime (orchestrator-managed)
  status: SyncStatus

  // Configuration (user-provided)
  source: SourceConfig
  destination: DestinationConfig
  /**
   * Which streams to sync and per-stream options.
   * If omitted, sync all streams discovered by the source.
   */
  streams?: StreamConfig[]

  /**
   * Per-stream checkpoint map. Managed by the orchestrator.
   * Keyed by stream name, values are opaque to everything except the source.
   * e.g. { "customers": { "after": "cus_999" }, "invoices": { "after": "inv_500" } }
   */
  state?: Record<string, unknown>
}
