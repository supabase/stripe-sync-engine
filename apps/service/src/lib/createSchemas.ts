import { z } from 'zod'
import type { ConnectorResolver } from '@stripe/sync-engine'

// MARK: - Static schemas (independent of connector set)

export const StreamConfig = z.object({
  name: z.string().describe('Stream (table) name to sync.'),
  sync_mode: z
    .enum(['incremental', 'full_refresh'])
    .optional()
    .describe('How the source reads this stream. Defaults to full_refresh.'),
  backfill_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap backfill to this many records, then mark the stream complete.'),
})

export const LogEntry = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).describe('Log severity level.'),
  message: z.string().describe('Human-readable log message.'),
  stream: z.string().optional().describe('Stream that produced this log entry, if applicable.'),
  timestamp: z.string().describe('ISO 8601 timestamp when the log entry was produced.'),
})

// MARK: - Dynamic schema factory (depends on registered connectors)

/**
 * Build Zod schemas with discriminated unions from registered connectors.
 *
 * Only works for in-memory connector references (those passed to
 * `createConnectorResolver({ sources, destinations })`). Their specs are
 * available synchronously via `resolver.sources()` / `resolver.destinations()`.
 *
 * TODO: support subprocess connectors (resolver.resolveSource / resolveDestination)
 * which require an async call to discover their spec at runtime.
 */
export function createSchemas(resolver: ConnectorResolver) {
  // Build source config discriminated union
  const sourceVariants = [...resolver.sources()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const obj = base instanceof z.ZodObject ? base : z.object({})
    return obj.extend({ type: z.literal(name) })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SourceConfig =
    sourceVariants.length > 0
      ? z.discriminatedUnion('type', sourceVariants as [any, any, ...any[]])
      : z.object({ type: z.string() }).catchall(z.unknown())

  // Build destination config discriminated union
  const destVariants = [...resolver.destinations()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const obj = base instanceof z.ZodObject ? base : z.object({})
    return obj.extend({ type: z.literal(name) })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DestinationConfig =
    destVariants.length > 0
      ? z.discriminatedUnion('type', destVariants as [any, any, ...any[]])
      : z.object({ type: z.string() }).catchall(z.unknown())

  // Composed schemas
  const Pipeline = z.object({
    id: z.string().describe('Unique pipeline identifier (e.g. pipe_abc123).'),
    source: SourceConfig,
    destination: DestinationConfig,
    streams: z
      .array(StreamConfig)
      .optional()
      .describe('Selected streams to sync. All streams synced if omitted.'),
  })

  const CreatePipeline = z.object({
    source: SourceConfig,
    destination: DestinationConfig,
    streams: z
      .array(StreamConfig)
      .optional()
      .describe('Selected streams to sync. All streams synced if omitted.'),
  })

  const UpdatePipeline = CreatePipeline.partial()

  return {
    SourceConfig,
    DestinationConfig,
    StreamConfig,
    Pipeline,
    CreatePipeline,
    UpdatePipeline,
    LogEntry,
  }
}

// MARK: - Inferred types

type Schemas = ReturnType<typeof createSchemas>

export type SourceConfig = z.infer<Schemas['SourceConfig']>
export type DestinationConfig = z.infer<Schemas['DestinationConfig']>
export type StreamConfig = z.infer<typeof StreamConfig>
export type Pipeline = z.infer<Schemas['Pipeline']>
export type CreatePipeline = z.infer<Schemas['CreatePipeline']>
export type UpdatePipeline = z.infer<Schemas['UpdatePipeline']>
export type LogEntry = z.infer<typeof LogEntry>
