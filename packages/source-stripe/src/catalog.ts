import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { ParsedResourceTable } from '@stripe/sync-openapi'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/**
 * Derive a CatalogPayload by merging OpenAPI-parsed tables with registry metadata.
 * `_account_id` and `_updated_at` (staleness, see DDR-009) are injected into properties.
 * The returned catalog is account-agnostic — call {@link stampAccountIdEnum} to
 * add the per-pipeline allow-list before handing it to destinations.
 */
export function catalogFromOpenApi(
  tables: ParsedResourceTable[],
  registry: Record<string, ResourceConfig>
): CatalogPayload {
  const tableMap = new Map(tables.map((t) => [t.tableName, t]))

  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => {
      const table = tableMap.get(cfg.tableName)
      const stream: Stream = {
        name: cfg.tableName,
        primary_key: [['id'], ['_account_id']],
        newer_than_field: '_updated_at',
        metadata: { resource_name: name },
      }

      if (table) {
        const jsonSchema = parsedTableToJsonSchema(table)
        const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>
        properties._account_id = { type: 'string' }
        jsonSchema.properties = properties
        properties._updated_at = { type: 'integer' }
        const required = Array.isArray(jsonSchema.required) ? [...jsonSchema.required] : []
        if (!required.includes('_account_id')) {
          required.push('_account_id')
        }
        if (!required.includes('_updated_at')) {
          required.push('_updated_at')
        }
        jsonSchema.required = required

        stream.json_schema = jsonSchema
      }

      return stream
    })

  return { streams }
}

/**
 * Deep-clone a catalog and stamp `_account_id.enum` on every stream's
 * JSON Schema. This keeps the cached catalog account-agnostic while
 * producing a per-pipeline catalog that destinations can use for
 * CHECK constraint generation.
 */
export function stampAccountIdEnum(
  catalog: CatalogPayload,
  allowedAccountIds: string[]
): CatalogPayload {
  if (allowedAccountIds.length === 0) {
    throw new Error('stampAccountIdEnum requires non-empty allowedAccountIds')
  }
  return {
    ...catalog,
    streams: catalog.streams.map((s) => {
      if (!s.json_schema) return s
      const props = { ...(s.json_schema.properties as Record<string, unknown>) }
      props._account_id = { type: 'string', enum: allowedAccountIds }
      return { ...s, json_schema: { ...s.json_schema, properties: props } }
    }),
  }
}
