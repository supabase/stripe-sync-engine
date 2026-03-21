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

// ── Shared schemas (not connector-specific) ─────────────────────

export const StreamConfigSchema = z.object({
  name: z.string(),
  sync_mode: z.enum(['incremental', 'full_refresh']).optional(),
  skip_backfill: z.boolean().optional(),
})

export const SyncStatusSchema = z.enum(['backfilling', 'syncing', 'paused', 'error'])

export const UpdateCredentialSchema = z.record(z.string(), z.unknown())

export const LogEntrySchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  stream: z.string().optional(),
  timestamp: z.string(),
})

// ── Dynamic schema builder ──────────────────────────────────────

/**
 * Build all Zod validation schemas dynamically from connector config schemas.
 *
 * Each connector's `spec().config` (JSON Schema) is converted to a Zod schema
 * via `z.fromJSONSchema()` by the resolver. This function composes those into
 * the discriminated unions used at the API boundary.
 *
 * For each connector, all config fields become **optional** — any field can
 * come from either the credential or the sync config. `resolve()` merges them
 * at runtime.
 */
export function buildSchemas(opts: {
  sources: ReadonlyMap<string, z.ZodType>
  destinations: ReadonlyMap<string, z.ZodType>
}) {
  // Helper: ensure schema is a ZodObject for .partial()/.merge() composability
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function toObject(schema: z.ZodType): z.ZodObject<Record<string, any>> {
    if (schema instanceof z.ZodObject) return schema
    return z.object({})
  }

  // ── Source config variants ──────────────────────────────────────
  const sourceVariants = [...opts.sources.entries()].map(([name, configSchema]) =>
    z
      .object({ type: z.literal(name), credential_id: z.string().optional() })
      .merge(toObject(configSchema).partial())
      .passthrough()
  )

  // ── Destination config variants ────────────────────────────────
  const destVariants = [...opts.destinations.entries()].map(([name, configSchema]) =>
    z
      .object({ type: z.literal(name), credential_id: z.string().optional() })
      .merge(toObject(configSchema).partial())
      .passthrough()
  )

  // ── Credential config variants (sources + destinations) ────────
  const credVariants = [
    ...[...opts.sources.entries()].map(([name, configSchema]) =>
      z
        .object({ type: z.literal(name) })
        .merge(toObject(configSchema).partial())
        .passthrough()
    ),
    ...[...opts.destinations.entries()].map(([name, configSchema]) =>
      z
        .object({ type: z.literal(name) })
        .merge(toObject(configSchema).partial())
        .passthrough()
    ),
  ]

  // ── Assemble discriminated unions ──────────────────────────────
  // discriminatedUnion requires a specific tuple type but we build arrays
  // dynamically — the `as` casts are unavoidable here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const asDU = (variants: z.ZodObject<Record<string, any>>[]) =>
    z.discriminatedUnion('type', variants as [z.ZodObject, ...z.ZodObject[]])

  const SourceConfigSchema =
    sourceVariants.length > 0 ? asDU(sourceVariants) : (z.never() as z.ZodType)

  const DestinationConfigSchema =
    destVariants.length > 0 ? asDU(destVariants) : (z.never() as z.ZodType)

  const CredentialConfigSchema =
    credVariants.length > 0 ? asDU(credVariants) : (z.never() as z.ZodType)

  // ── Credential (full resource with id + account_id) ────────────
  const credResourceVariants = credVariants.map((v) =>
    v.extend({ id: z.string(), account_id: z.string() })
  )
  const CredentialSchema =
    credResourceVariants.length > 0 ? asDU(credResourceVariants) : (z.never() as z.ZodType)

  // ── Sync ───────────────────────────────────────────────────────
  const SyncSchema = z.object({
    id: z.string(),
    account_id: z.string(),
    status: SyncStatusSchema,
    source: SourceConfigSchema,
    destination: DestinationConfigSchema,
    streams: z.array(StreamConfigSchema).optional(),
  })

  const CreateSyncSchema = SyncSchema.omit({ id: true })
  const UpdateSyncSchema = SyncSchema.omit({ id: true }).partial()

  return {
    SourceConfigSchema,
    DestinationConfigSchema,
    CredentialConfigSchema,
    CredentialSchema,
    SyncSchema,
    CreateSyncSchema,
    UpdateSyncSchema,
  }
}
