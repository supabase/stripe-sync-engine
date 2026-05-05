import type { ConfiguredCatalog, ProgressPayload } from '@stripe/sync-protocol'

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
      if (cs.stream.newer_than_field) allowed.add(cs.stream.newer_than_field)
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

/** Exclude streams that already reached a terminal state in prior run progress. */
export function excludeTerminalStreams(
  catalog: ConfiguredCatalog,
  progress?: Pick<ProgressPayload, 'streams'>
): ConfiguredCatalog {
  const terminalStreams = new Set(
    Object.entries(progress?.streams ?? {})
      .filter(
        ([, stream]) =>
          stream.status === 'completed' ||
          stream.status === 'skipped' ||
          stream.status === 'errored'
      )
      .map(([name]) => name)
  )

  if (terminalStreams.size === 0) return catalog

  return {
    ...catalog,
    streams: catalog.streams.filter((stream) => !terminalStreams.has(stream.stream.name)),
  }
}
