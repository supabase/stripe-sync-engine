import type { ConfiguredCatalog } from '@stripe/sync-protocol'

export type CatalogMiddleware = (catalog: ConfiguredCatalog) => ConfiguredCatalog

/**
 * Prune each stream's json_schema.properties down to the fields selected in
 * ConfiguredStream.fields (plus all primary-key fields).
 * Streams without fields or without json_schema pass through unchanged.
 */
export function applySelection(catalog: ConfiguredCatalog): ConfiguredCatalog {
  return {
    streams: catalog.streams.map((cs) => {
      if (!cs.fields?.length) return cs
      const props = cs.stream.json_schema?.properties as Record<string, unknown> | undefined
      if (!props) return cs
      const allowed = new Set(cs.fields)
      for (const path of cs.stream.primary_key) {
        if (path[0]) allowed.add(path[0])
      }
      return {
        ...cs,
        stream: {
          ...cs.stream,
          json_schema: {
            ...cs.stream.json_schema,
            properties: Object.fromEntries(Object.entries(props).filter(([k]) => allowed.has(k))),
          },
        },
      }
    }),
  }
}
