import { z } from 'zod'
import type { ConnectorResolver } from './resolver.js'

// ── Naming helpers ───────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function toPascal(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => capitalize(w))
    .join('')
}

/** OAS schema name, e.g. SourceStripeConfig, DestinationPostgresConfig */
export function connectorSchemaName(name: string, role: 'Source' | 'Destination'): string {
  return `${role}${toPascal(name)}Config`
}

/** Input payload schema name, e.g. SourceStripeInput */
export function connectorInputSchemaName(name: string): string {
  return `Source${toPascal(name)}Input`
}

/** Union schema ID for a connector role, e.g. 'Source' → 'SourceConfig' */
export function connectorUnionId(role: 'Source' | 'Destination'): string {
  return `${role}Config`
}

// ── Schema factory ───────────────────────────────────────────────

const StreamConfig = z.object({
  name: z.string().describe('Stream (table) name to sync.'),
  sync_mode: z
    .enum(['incremental', 'full_refresh'])
    .optional()
    .describe('How the source reads this stream. Defaults to full_refresh.'),
  fields: z.array(z.string()).optional().describe('If set, only these fields are synced.'),
  backfill_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Cap backfill to this many records, then mark the stream complete.'),
})

/**
 * Build typed Zod schemas with `.meta({ id })` annotations from registered connectors.
 *
 * Schemas are used for both runtime validation (via Zod transform+pipe in route headers)
 * and OAS 3.1 spec generation (zod-openapi auto-registers `.meta({ id })` as named components).
 *
 * Individual config schemas (e.g. `SourceStripeConfig`) contain only the raw connector
 * payload — the `{ type, [connectorName]: payload }` envelope is defined at the union level.
 */
export function createConnectorSchemas(resolver: ConnectorResolver) {
  // Source config discriminated union
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

  // Destination config discriminated union
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

  // Source input discriminated union (only sources with rawInputJsonSchema)
  const inputVariants = [...resolver.sources()]
    .filter(([, r]) => r.rawInputJsonSchema != null)
    .map(([name, r]) => {
      const base = z.fromJSONSchema(r.rawInputJsonSchema!)
      const obj = (base instanceof z.ZodObject ? base : z.object({})).meta({
        id: connectorInputSchemaName(name),
      })
      return z.object({ type: z.literal(name), [name]: obj })
    })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SourceInput =
    inputVariants.length > 0
      ? z
          .discriminatedUnion('type', inputVariants as [any, any, ...any[]])
          .meta({ id: 'SourceInput' })
      : undefined

  const PipelineConfig = z
    .object({
      source: SourceConfig,
      destination: DestinationConfig,
      streams: z.array(StreamConfig).optional(),
    })
    .meta({ id: 'PipelineConfig' })

  return { SourceConfig, DestinationConfig, SourceInput, PipelineConfig }
}
