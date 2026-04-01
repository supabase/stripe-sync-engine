import type { Destination, ConfiguredCatalog } from '@stripe/sync-protocol'

function filterCatalog(catalog: ConfiguredCatalog): ConfiguredCatalog {
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

/**
 * Wrap a Destination to prune each stream's json_schema.properties
 * down to the fields selected in ConfiguredStream.fields.
 * Streams without fields or without json_schema pass through unchanged.
 */
export function withCatalogFilter(dest: Destination): Destination {
  return {
    spec: () => dest.spec(),
    check: (params) => dest.check(params),
    write(params, $stdin) {
      return dest.write({ ...params, catalog: filterCatalog(params.catalog) }, $stdin)
    },
    ...(dest.setup && {
      async setup(params) {
        return dest.setup!({ ...params, catalog: filterCatalog(params.catalog) })
      },
    }),
    ...(dest.teardown && {
      teardown: (params: { config: Record<string, unknown> }) => dest.teardown!(params),
    }),
  }
}
