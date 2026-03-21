import { z } from '@hono/zod-openapi'

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

const PostgresCredConfig = z.object({
  type: z.literal('postgres'),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  password: z.string(),
  database: z.string(),
})

const GoogleCredConfig = z.object({
  type: z.literal('google'),
  client_id: z.string(),
  client_secret: z.string(),
  refresh_token: z.string().optional(),
})

const StripeCredConfig = z.object({
  type: z.literal('stripe'),
  api_key: z.string(),
})

export const CredentialConfigSchema = z.discriminatedUnion('type', [
  PostgresCredConfig,
  GoogleCredConfig,
  StripeCredConfig,
])

// ── Credential (full resource with id + account_id) ─────────────

const credBase = {
  id: z.string().openapi({ example: 'cred_abc123' }),
  account_id: z.string().openapi({ example: 'acct_abc123' }),
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
  id: z.string().openapi({ example: 'sync_abc123' }),
  account_id: z.string().openapi({ example: 'acct_abc123' }),
  status: SyncStatusSchema,
  source: SourceConfigSchema,
  destination: DestinationConfigSchema,
  streams: z.array(StreamConfigSchema).optional(),
})

export const CreateSyncSchema = SyncSchema.omit({ id: true })
export const UpdateSyncSchema = SyncSchema.omit({ id: true }).partial()

// ── Update Credential (loose for PATCH) ─────────────────────────

export const UpdateCredentialSchema = z.record(z.string(), z.unknown())

// ── Delete Response ─────────────────────────────────────────────

export const DeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
})

// ── Error ───────────────────────────────────────────────────────

export const ErrorSchema = z.object({
  error: z.unknown(),
})

// ── List Response ───────────────────────────────────────────────

export function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}
