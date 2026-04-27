import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { ParsedResourceTable } from '@stripe/sync-openapi'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/**
 * Derive a CatalogPayload by merging OpenAPI-parsed tables with registry metadata.
 * `_account_id` (PK) and `_updated_at` (staleness, see DDR-009) are injected into properties.
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
