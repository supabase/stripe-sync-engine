import { z } from 'zod'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { connectorSchemaName, connectorUnionId } from '@stripe/sync-engine'
import { SyncState } from '@stripe/sync-protocol'

// MARK: - Pipeline status enums

export const DesiredStatus = z
  .enum(['active', 'paused', 'deleted'])
  .describe('User-controlled lifecycle state.')
export type DesiredStatus = z.infer<typeof DesiredStatus>

export const PipelineStatus = z
  .enum(['setup', 'backfill', 'ready', 'paused', 'teardown', 'error'])
  .describe('Workflow-controlled execution state.')
export type PipelineStatus = z.infer<typeof PipelineStatus>

export const PipelineId = z
  .string()
  .min(3)
  .max(64)
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    'Pipeline id must start with a lowercase letter and contain only lowercase letters, numbers, underscores, or hyphens.'
  )
  .describe('Unique pipeline identifier (e.g. pipe_abc123).')

/**
 * Derive user-facing status from the two independent fields.
 *
 * | desired  | workflow  | → status      |
 * |----------|-----------|---------------|
 * | deleted  | *         | tearing_down  |
 * | *        | teardown  | tearing_down  |
 * | *        | error     | error         |
 * | *        | setup     | setting_up    |
 * | active   | paused    | resuming      |
 * | paused   | paused    | paused        |
 * | paused   | *         | pausing       |
 * | active   | backfill  | backfilling   |
 * | active   | ready     | ready         |
 */

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
  // Build source config discriminated union with .meta({ id }) for OAS component registration
  const sourceVariants = [...resolver.sources()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const obj = (base instanceof z.ZodObject ? base : z.object({})).meta({
      id: connectorSchemaName(name, 'Source'),
    })
    return z.object({ type: z.literal(name), [name]: obj })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SourceConfig =
    sourceVariants.length > 0
      ? z
          .discriminatedUnion('type', sourceVariants as [any, any, ...any[]])
          .meta({ id: connectorUnionId('Source') })
      : z.object({ type: z.string() }).catchall(z.unknown())

  // Build destination config discriminated union
  const destVariants = [...resolver.destinations()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const obj = (base instanceof z.ZodObject ? base : z.object({})).meta({
      id: connectorSchemaName(name, 'Destination'),
    })
    return z.object({ type: z.literal(name), [name]: obj })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DestinationConfig =
    destVariants.length > 0
      ? z
          .discriminatedUnion('type', destVariants as [any, any, ...any[]])
          .meta({ id: connectorUnionId('Destination') })
      : z.object({ type: z.string() }).catchall(z.unknown())

  // Composed schemas
  const Pipeline = z
    .object({
      id: PipelineId,
      source: SourceConfig,
      destination: DestinationConfig,
      streams: z
        .array(StreamConfig)
        .optional()
        .describe('Selected streams to sync. All streams synced if omitted.'),
      desired_status: DesiredStatus.default('active').describe(
        'User-controlled lifecycle state. Set via PATCH to pause, resume, or delete.'
      ),
      status: PipelineStatus.default('setup').describe(
        'Workflow-controlled execution state. Updated by the Temporal workflow.'
      ),
      sync_state: SyncState.optional().describe(
        'Latest full sync checkpoint emitted by the engine. ' +
          'Includes source, destination, and sync-run state for the next request.'
      ),
    })
    .meta({ id: 'Pipeline' })

  const CreatePipeline = z
    .object({
      id: PipelineId.optional().describe(
        'Optional pipeline identifier. If omitted, the service generates one (e.g. pipe_abc123).'
      ),
      source: SourceConfig,
      destination: DestinationConfig,
      streams: z
        .array(StreamConfig)
        .optional()
        .describe('Selected streams to sync. All streams synced if omitted.'),
    })
    .meta({ id: 'CreatePipeline' })

  const UpdatePipeline = CreatePipeline.extend({
    desired_status: DesiredStatus.optional().describe(
      'Set to "paused" to pause, "active" to resume, "deleted" to tear down.'
    ),
  })
    .partial()
    .meta({ id: 'UpdatePipeline' })

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
