import { z } from 'zod'

// In Zod v4, objects strip unknown keys by default.
// Schemas that accept connector-specific fields use .catchall(z.unknown()).

// MARK: - Pipeline schemas

export const SourceConfig = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown())
export type SourceConfig = z.infer<typeof SourceConfig>

export const DestinationConfig = z
  .object({
    type: z.string(),
  })
  .catchall(z.unknown())
export type DestinationConfig = z.infer<typeof DestinationConfig>

export const StreamConfig = z.object({
  name: z.string(),
  sync_mode: z.enum(['incremental', 'full_refresh']).optional(),
})
export type StreamConfig = z.infer<typeof StreamConfig>

export const Pipeline = z.object({
  id: z.string(),
  source: SourceConfig,
  destination: DestinationConfig,
  streams: z.array(StreamConfig).optional(),
})
export type Pipeline = z.infer<typeof Pipeline>

export const CreatePipeline = z.object({
  source: SourceConfig,
  destination: DestinationConfig,
  streams: z.array(StreamConfig).optional(),
})
export type CreatePipeline = z.infer<typeof CreatePipeline>

export const UpdatePipeline = CreatePipeline.partial()
export type UpdatePipeline = z.infer<typeof UpdatePipeline>

// MARK: - Log entry

export const LogEntry = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  stream: z.string().optional(),
  timestamp: z.string(),
})
export type LogEntry = z.infer<typeof LogEntry>
