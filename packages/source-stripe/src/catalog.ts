import type { CatalogMessage, Stream } from '@stripe/sync-protocol'
import type { ResourceConfig } from './types'

/** Derive a CatalogMessage from the existing resource registry. */
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
