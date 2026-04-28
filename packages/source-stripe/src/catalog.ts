import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/**
 * Derive a CatalogPayload from the registry. Each syncable ResourceConfig must
 * carry a `parsedTable`; throws if one is missing (ghost-table guard).
 */
export function catalogFromOpenApi(registry: Record<string, ResourceConfig>): CatalogPayload {
  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => {
      if (!cfg.parsedTable) {
        throw new Error(
          `catalogFromOpenApi: registry entry "${cfg.tableName}" has no parsedTable. ` +
            `Pass parsedTables to buildResourceRegistry so every entry carries its schema.`
        )
      }

      const jsonSchema = parsedTableToJsonSchema(cfg.parsedTable)
      const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>
      properties._account_id = { type: 'string' }
      properties._updated_at = { type: 'integer' }
      jsonSchema.properties = properties
      const required = Array.isArray(jsonSchema.required) ? [...jsonSchema.required] : []
      if (!required.includes('_account_id')) required.push('_account_id')
      if (!required.includes('_updated_at')) required.push('_updated_at')
      jsonSchema.required = required

      return {
        name: cfg.tableName,
        primary_key: [['id'], ['_account_id']],
        newer_than_field: '_updated_at',
        metadata: {
          resource_name: name,
          supports_realtime_sync: true,
        },
        json_schema: jsonSchema,
      }
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
