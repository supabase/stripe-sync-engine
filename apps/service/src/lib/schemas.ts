import { z } from 'zod'

// MARK: - Credential schemas

export const Credential = z
  .object({
    id: z.string(),
    type: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough()
export type Credential = z.infer<typeof Credential>

export const CreateCredential = z.object({ type: z.string() }).passthrough()
export type CreateCredential = z.infer<typeof CreateCredential>

export const UpdateCredential = z.record(z.string(), z.unknown())
export type UpdateCredential = z.infer<typeof UpdateCredential>

// MARK: - Sync config schemas

export const SourceConfig = z
  .object({
    type: z.string(),
    credential_id: z.string().optional(),
  })
  .passthrough()
export type SourceConfig = z.infer<typeof SourceConfig>

export const DestinationConfig = z
  .object({
    type: z.string(),
    credential_id: z.string().optional(),
  })
  .passthrough()
export type DestinationConfig = z.infer<typeof DestinationConfig>

export const StreamConfig = z.object({
  name: z.string(),
  sync_mode: z.enum(['incremental', 'full_refresh']).optional(),
})
export type StreamConfig = z.infer<typeof StreamConfig>

export const SyncConfig = z.object({
  id: z.string(),
  source: SourceConfig,
  destination: DestinationConfig,
  streams: z.array(StreamConfig).optional(),
})
export type SyncConfig = z.infer<typeof SyncConfig>

export const CreateSync = z.object({
  source: SourceConfig,
  destination: DestinationConfig,
  streams: z.array(StreamConfig).optional(),
})
export type CreateSync = z.infer<typeof CreateSync>

export const UpdateSync = CreateSync.partial()
export type UpdateSync = z.infer<typeof UpdateSync>

// MARK: - Log entry

export const LogEntry = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  stream: z.string().optional(),
  timestamp: z.string(),
})
export type LogEntry = z.infer<typeof LogEntry>
