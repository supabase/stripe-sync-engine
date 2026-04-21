import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { ParsedResourceTable } from '@stripe/sync-openapi'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/**
 * Derive a CatalogPayload by merging OpenAPI-parsed tables with registry metadata.
 * Each stream gets json_schema from the parsed OpenAPI spec, with `_account_id`
 * injected so downstream consumers see the full data shape.
 */
export function catalogFromOpenApi(
  tables: ParsedResourceTable[],
  registry: Record<string, ResourceConfig>
): CatalogPayload {
  const tableMap = new Map(tables.map((t) => [t.tableName, t]))

  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false && tableMap.has(cfg.tableName))
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => {
      const table = tableMap.get(cfg.tableName)
      const stream: Stream = {
        name: cfg.tableName,
        primary_key: [['id'], ['_account_id']],
        metadata: { resource_name: name },
      }

      if (table) {
        const jsonSchema = parsedTableToJsonSchema(table)
        const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>
        properties._account_id = { type: 'string' }
        jsonSchema.properties = properties

        const required = Array.isArray(jsonSchema.required) ? [...jsonSchema.required] : []
        if (!required.includes('_account_id')) {
          required.push('_account_id')
        }
        jsonSchema.required = required

        stream.json_schema = jsonSchema

        // Only set newer_than_field if the column will actually be projected
        if (cfg.supportsCreatedFilter && 'updated' in properties) {
          stream.newer_than_field = 'updated'
        }
      }

      return stream
    })

  return { streams }
}
