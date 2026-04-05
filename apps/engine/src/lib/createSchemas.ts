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
  // Build inner config schemas and envelope variants in one pass per role
  const sources = [...resolver.sources()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const config = (base instanceof z.ZodObject ? base : z.object({})).meta({
      id: connectorSchemaName(name, 'Source'),
    })
    return { name, config, variant: z.object({ type: z.literal(name), [name]: config }) }
  })

  const destinations = [...resolver.destinations()].map(([name, r]) => {
    const base = z.fromJSONSchema(r.rawConfigJsonSchema)
    const config = (base instanceof z.ZodObject ? base : z.object({})).meta({
      id: connectorSchemaName(name, 'Destination'),
    })
    return { name, config, variant: z.object({ type: z.literal(name), [name]: config }) }
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SourceConfig =
    sources.length > 0
      ? z
          .discriminatedUnion('type', sources.map((s) => s.variant) as [any, any, ...any[]])
          .meta({ id: connectorUnionId('Source') })
      : z.object({ type: z.string() }).catchall(z.unknown())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DestinationConfig =
    destinations.length > 0
      ? z
          .discriminatedUnion('type', destinations.map((d) => d.variant) as [any, any, ...any[]])
          .meta({ id: connectorUnionId('Destination') })
      : z.object({ type: z.string() }).catchall(z.unknown())

  // Source input message envelope: { type: 'source_input', source_input: { ...connector payload } }
  const inputSchemas = [...resolver.sources()]
    .filter(([, r]) => r.rawInputJsonSchema != null)
    .map(([name, r]) => {
      const base = z.fromJSONSchema(r.rawInputJsonSchema!)
      return (base instanceof z.ZodObject ? base : z.object({})).meta({
        id: connectorInputSchemaName(name),
      })
    })

  const SourceInput =
    inputSchemas.length > 0
      ? z
          .object({
            type: z.literal('source_input'),
            source_input: configUnion(inputSchemas),
          })
          .meta({ id: 'SourceInput' })
      : undefined

  const PipelineConfig = z
    .object({
      source: SourceConfig,
      destination: DestinationConfig,
      streams: z.array(StreamConfig).optional(),
    })
    .meta({ id: 'PipelineConfig' })

  // Schema names for control message post-processing — the OAS spec's ControlMessage
  // source_config/destination_config fields get patched to $ref these typed schemas
  // instead of the protocol's untyped Record<string, unknown>.
  const sourceConfigNames = sources.map((s) => connectorSchemaName(s.name, 'Source'))
  const destConfigNames = destinations.map((d) => connectorSchemaName(d.name, 'Destination'))

  return {
    SourceConfig,
    DestinationConfig,
    SourceInput,
    PipelineConfig,
    sourceConfigNames,
    destConfigNames,
  }
}

/** Single schema, union, or fallback record from a list of config schemas. */
function configUnion(configs: z.ZodType[]): z.ZodType {
  if (configs.length === 0) return z.record(z.string(), z.unknown())
  if (configs.length === 1) return configs[0]!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return z.union(configs as [any, any, ...any[]])
}
