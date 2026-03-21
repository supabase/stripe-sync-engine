import { z } from 'zod'

// ── Store types ─────────────────────────────────────────────────
// Loose types for internal storage. Decoupled from the strict Zod
// schemas below so that stores, service code, and tests remain
// flexible. The Zod schemas are the validation contract at the API
// boundary; these types are the storage contract.

/** A stored credential — flat shape, type-specific fields at top level. */
export type Credential = {
  id: string
  /** Credential type — e.g. "stripe", "postgres", "google". */
  type: string
  created_at: string
  updated_at: string
  /** Type-specific fields (api_key, connection_string, etc.) at top level. */
  [key: string]: unknown
}

/**
 * Stored form of a sync configuration. References credentials by ID,
 * does not contain state. Resolved to SyncParams before calling the engine.
 */
export type SyncConfig = {
  id: string
  /** Account identifier — optional, set by the API layer. */
  account_id?: string
  /** Sync status — optional, set by the API layer. */
  status?: string
  source: {
    type: string
    credential_id?: string
    [key: string]: unknown
  }
  destination: {
    type: string
    credential_id?: string
    [key: string]: unknown
  }
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
}

/** Structured log entry written by the service during sync runs. */
export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stream?: string
  timestamp: string
}

// ── Zod validation schemas ──────────────────────────────────────
// Strict schemas for validating API/CLI input. Used at the boundary
// where untrusted data enters the system.

// ── Stripe API Version ──────────────────────────────────────────

export const StripeApiVersionSchema = z.enum([
  '2025-04-30.basil',
  '2025-03-31.basil',
  '2024-12-18.acacia',
  '2024-11-20.acacia',
  '2024-10-28.acacia',
  '2024-09-30.acacia',
])

// ── Credential Config ───────────────────────────────────────────

const PostgresCredConfig = z
  .object({
    type: z.literal('postgres'),
    host: z.string(),
    port: z.number(),
    user: z.string(),
    password: z.string(),
    database: z.string(),
  })
  .passthrough()

const GoogleCredConfig = z
  .object({
    type: z.literal('google'),
    client_id: z.string(),
    client_secret: z.string(),
    refresh_token: z.string().optional(),
  })
  .passthrough()

const StripeCredConfig = z
  .object({
    type: z.literal('stripe'),
    api_key: z.string(),
  })
  .passthrough()

export const CredentialConfigSchema = z.discriminatedUnion('type', [
  PostgresCredConfig,
  GoogleCredConfig,
  StripeCredConfig,
])

// ── Credential (full resource with id + account_id) ─────────────

const credBase = {
  id: z.string(),
  account_id: z.string(),
}

export const CredentialSchema = z.discriminatedUnion('type', [
  PostgresCredConfig.extend(credBase),
  GoogleCredConfig.extend(credBase),
  StripeCredConfig.extend(credBase),
])

// ── Source Config ────────────────────────────────────────────────

export const SourceConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stripe-api-core'),
    livemode: z.boolean(),
    api_version: StripeApiVersionSchema,
    credential_id: z.string(),
  }),
  z.object({
    type: z.literal('stripe-api-reporting'),
    livemode: z.boolean(),
    api_version: StripeApiVersionSchema,
    credential_id: z.string(),
  }),
  z.object({
    type: z.literal('stripe-event-bridge'),
    livemode: z.boolean(),
    account_id: z.string(),
  }),
])

// ── Destination Config ──────────────────────────────────────────

export const DestinationConfigSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('postgres'),
    schema_name: z.string(),
    credential_id: z.string(),
  }),
  z.object({
    type: z.literal('google-sheets'),
    google_sheet_id: z.string(),
    credential_id: z.string(),
  }),
])

// ── Stream Config ───────────────────────────────────────────────

export const StreamConfigSchema = z.object({
  name: z.string(),
  sync_mode: z.enum(['incremental', 'full_refresh']).optional(),
  skip_backfill: z.boolean().optional(),
})

// ── Sync Status ─────────────────────────────────────────────────

export const SyncStatusSchema = z.enum(['backfilling', 'syncing', 'paused', 'error'])

// ── Sync ────────────────────────────────────────────────────────

export const SyncSchema = z.object({
  id: z.string(),
  account_id: z.string(),
  status: SyncStatusSchema,
  source: SourceConfigSchema,
  destination: DestinationConfigSchema,
  streams: z.array(StreamConfigSchema).optional(),
})

export const CreateSyncSchema = SyncSchema.omit({ id: true })
export const UpdateSyncSchema = SyncSchema.omit({ id: true }).partial()

// ── Update Credential (loose for PATCH) ─────────────────────────

export const UpdateCredentialSchema = z.record(z.string(), z.unknown())

// ── Log Entry ───────────────────────────────────────────────────

export const LogEntrySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  stream: z.string().optional(),
  timestamp: z.string(),
})
