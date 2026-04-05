// ── Generic helpers ──────────────────────────────────────────────

export function endpointTable(spec: { paths?: Record<string, unknown> }): string {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { summary?: string }>)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => `| ${method.toUpperCase()} | ${path} | ${op.summary ?? ''} |`)
  )
  return ['| Method | Path | Summary |', '|--------|------|---------|', ...rows].join('\n')
}

/**
 * Patch the generated ControlMessage schema so that source_config / destination_config
 * reference the actual typed connector config schemas ($ref) instead of the protocol's
 * untyped `additionalProperties: {}`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function patchControlMessageSchema(spec: any, sourceNames: string[], destNames: string[]) {
  const control = spec.components?.schemas?.ControlMessage?.properties?.control
  if (!control?.oneOf) return

  for (const variant of control.oneOf) {
    const ct = variant.properties?.control_type?.const
    if (ct === 'source_config' && sourceNames.length > 0) {
      variant.properties.source_config =
        sourceNames.length === 1
          ? { $ref: `#/components/schemas/${sourceNames[0]}` }
          : { oneOf: sourceNames.map((n) => ({ $ref: `#/components/schemas/${n}` })) }
    } else if (ct === 'destination_config' && destNames.length > 0) {
      variant.properties.destination_config =
        destNames.length === 1
          ? { $ref: `#/components/schemas/${destNames[0]}` }
          : { oneOf: destNames.map((n) => ({ $ref: `#/components/schemas/${n}` })) }
    }
  }
}
