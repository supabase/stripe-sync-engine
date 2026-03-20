import type { CatalogMessage, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types'
import type { ParsedResourceTable } from './openapi/types'
import { parsedTableToJsonSchema } from './openapi/jsonSchemaConverter'

/** Derive a CatalogMessage from the existing resource registry (no json_schema). */
export function catalogFromRegistry(registry: Record<string, ResourceConfig>): CatalogMessage {
  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => ({
      name: cfg.tableName,
      primary_key: [['id']],
      metadata: { resource_name: name },
    }))

  return { type: 'catalog', streams }
}

/**
 * Derive a CatalogMessage by merging OpenAPI-parsed tables with registry metadata.
 * Each stream gets json_schema from the parsed OpenAPI spec.
 */
export function catalogFromOpenApi(
  tables: ParsedResourceTable[],
  registry: Record<string, ResourceConfig>
): CatalogMessage {
  const tableMap = new Map(tables.map((t) => [t.tableName, t]))

  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => {
      const table = tableMap.get(cfg.tableName)
      const stream: Stream = {
        name: cfg.tableName,
        primary_key: [['id']],
        metadata: { resource_name: name },
      }
      if (table) {
        stream.json_schema = parsedTableToJsonSchema(table)
      }
      return stream
    })

  return { type: 'catalog', streams }
}
