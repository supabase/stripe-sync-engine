import type { Sync, SyncStatus } from './types'

/**
 * Input for the bridge function. Matches what the v1 engine already has
 * available at the call site.
 */
export interface SyncBridgeInput {
  accountId: string
  runStartedAt: Date
  /** From StripeSyncConfig.stripeApiVersion or Stripe client */
  apiVersion: string
  /** Whether the Stripe key is a live-mode key */
  livemode: boolean
  /** Hash of the Stripe secret key (used as credential_id) */
  apiKeyHash: string
  /** From StripeSyncConfig.schemaName (default "stripe") */
  schemaName: string
  /** Opaque credential reference for the Postgres destination */
  destinationCredentialId: string
  /** Derived from sync run state: is the run closed? any errors? */
  runClosed: boolean
  hasErrors: boolean
  /** Stream names currently configured (from object runs) */
  streamNames?: string[]
  /** Per-stream checkpoint state (from _sync_obj_runs cursors) */
  state?: Record<string, unknown>
}

/**
 * Convert v1 RunKey + config into a v2 Sync resource.
 *
 * The `id` is synthesized from accountId + runStartedAt since v1 does not
 * have a dedicated sync ID. Future increments will introduce real sync IDs.
 */
export function syncFromBridgeInput(input: SyncBridgeInput): Sync {
  const status = deriveSyncStatus(input)

  const sync: Sync = {
    id: `sync_${input.accountId}_${input.runStartedAt.getTime()}` as `sync_${string}`,
    account_id: input.accountId as `acct_${string}`,
    status,
    source: {
      type: 'stripe-api-core',
      livemode: input.livemode,
      api_version: input.apiVersion,
      credential_id: input.apiKeyHash,
    },
    destination: {
      type: 'postgres',
      schema_name: input.schemaName,
      credential_id: input.destinationCredentialId,
    },
  }

  if (input.streamNames && input.streamNames.length > 0) {
    sync.streams = input.streamNames.map((name) => ({ name }))
  }

  if (input.state && Object.keys(input.state).length > 0) {
    sync.state = input.state
  }

  return sync
}

/** Derive SyncStatus from v1 run state. */
function deriveSyncStatus(input: SyncBridgeInput): SyncStatus {
  if (input.hasErrors) return 'error'
  if (!input.runClosed) return 'backfilling'
  return 'syncing'
}
