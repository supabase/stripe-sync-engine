import type { CatalogPayload, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types.js'
import type { ParsedResourceTable } from '@stripe/sync-openapi'
import { parsedTableToJsonSchema } from '@stripe/sync-openapi'

/** Derive a CatalogPayload from the existing resource registry (no json_schema). */
export function catalogFromRegistry(registry: Record<string, ResourceConfig>): CatalogPayload {
  const streams: Stream[] = Object.entries(registry)
    .filter(([, cfg]) => cfg.sync !== false)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([name, cfg]) => ({
      name: cfg.tableName,
      primary_key: [['id']],
      metadata: { resource_name: name },
    }))

  return { streams }
}

/**
 * Derive a CatalogPayload by merging OpenAPI-parsed tables with registry metadata.
 * Each stream gets json_schema from the parsed OpenAPI spec.
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
        primary_key: [['id']],
        metadata: { resource_name: name },
      }
      if (table) {
        stream.json_schema = parsedTableToJsonSchema(table)
      }
      return stream
    })

  return { streams }
}
