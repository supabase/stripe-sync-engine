import { defineCommand } from 'citty'
import type { CommandDef } from 'citty'

export type ConnectorBodyKey = 'source' | 'destination'

export function normalizeCliKey(value: string): string {
  return value
    .replace(/-/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

export function parseCliValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown) {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[path[path.length - 1]!] = value
}

export function applyConnectorShorthand(
  args: Record<string, unknown>,
  bodyKey: ConnectorBodyKey,
  connectorNames: string[]
) {
  const shorthandConfigs = new Map<string, Record<string, unknown>>()
  const connectorByPrefix = new Map(connectorNames.map((name) => [normalizeCliKey(name), name]))

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const dotIndex = rawKey.indexOf('.')
    if (dotIndex === -1) continue

    const connector = connectorByPrefix.get(normalizeCliKey(rawKey.slice(0, dotIndex)))
    if (!connector) continue

    const path = rawKey
      .slice(dotIndex + 1)
      .split('.')
      .map((segment) => normalizeCliKey(segment))
    if (path.length === 0) continue

    const config = shorthandConfigs.get(connector) ?? {}
    setNestedValue(config, path, parseCliValue(rawValue))
    shorthandConfigs.set(connector, config)
  }

  if (shorthandConfigs.size === 0) return args
  if (shorthandConfigs.size > 1) {
    throw new Error(
      `Multiple ${bodyKey} connectors specified via shorthand flags: ${[...shorthandConfigs.keys()].join(', ')}`
    )
  }

  const [connectorName, shorthandConfig] = [...shorthandConfigs.entries()][0]!
  const explicitBody = parseCliValue(args[bodyKey])

  if (explicitBody === undefined) {
    return {
      ...args,
      [bodyKey]: JSON.stringify({
        type: connectorName,
        [connectorName]: shorthandConfig,
      }),
    }
  }

  if (!explicitBody || typeof explicitBody !== 'object' || Array.isArray(explicitBody)) {
    throw new Error(`Expected --${bodyKey} to be a JSON object`)
  }

  const mergedBody = { ...(explicitBody as Record<string, unknown>) }
  const explicitType =
    typeof mergedBody.type === 'string' ? normalizeCliKey(mergedBody.type) : undefined
  if (explicitType && explicitType !== normalizeCliKey(connectorName)) {
    throw new Error(
      `--${bodyKey} type ${String(mergedBody.type)} conflicts with shorthand flags for ${connectorName}`
    )
  }

  mergedBody.type = connectorName
  const existingConfig =
    mergedBody[connectorName] &&
    typeof mergedBody[connectorName] === 'object' &&
    !Array.isArray(mergedBody[connectorName])
      ? (mergedBody[connectorName] as Record<string, unknown>)
      : {}
  mergedBody[connectorName] = { ...existingConfig, ...shorthandConfig }

  return {
    ...args,
    [bodyKey]: JSON.stringify(mergedBody),
  }
}

/**
 * Extracts connector override objects from CLI args (e.g. --postgres.url → destination override).
 * Returns `{ source?, destination? }` suitable for merging into pipeline configs or POST bodies.
 */
export function extractConnectorOverrides(
  args: Record<string, unknown>,
  options: { sources: string[]; destinations: string[] }
): { source?: Record<string, unknown>; destination?: Record<string, unknown> } {
  const result: { source?: Record<string, unknown>; destination?: Record<string, unknown> } = {}

  const allConnectors = [...options.sources, ...options.destinations]
  const connectorByPrefix = new Map(allConnectors.map((name) => [normalizeCliKey(name), name]))
  const sourceSet = new Set(options.sources.map(normalizeCliKey))

  assertNoDottedUnknownFlags(args, allConnectors)

  const grouped = new Map<string, Record<string, unknown>>()

  for (const [rawKey, rawValue] of Object.entries(args)) {
    const dotIndex = rawKey.indexOf('.')
    if (dotIndex === -1) continue

    const connector = connectorByPrefix.get(normalizeCliKey(rawKey.slice(0, dotIndex)))
    if (!connector) continue

    const path = rawKey
      .slice(dotIndex + 1)
      .split('.')
      .map((segment) => normalizeCliKey(segment))
    if (path.length === 0) continue

    const config = grouped.get(connector) ?? {}
    setNestedValue(config, path, parseCliValue(rawValue))
    grouped.set(connector, config)
  }

  for (const [connectorName, config] of grouped) {
    const bodyKey = sourceSet.has(normalizeCliKey(connectorName)) ? 'source' : 'destination'
    result[bodyKey] = { type: connectorName, [connectorName]: config }
  }

  return result
}

/**
 * Merges connector overrides (from extractConnectorOverrides) into a pipeline object in-place.
 * Each override's type-keyed config is shallow-merged on top of the existing connector config.
 * If a connector spec schema is provided, override keys are validated against it.
 */
export function mergeConnectorOverrides(
  pipeline: Record<string, unknown>,
  overrides: { source?: Record<string, unknown>; destination?: Record<string, unknown> },
  specSchemas?: { source?: Record<string, unknown>; destination?: Record<string, unknown> }
) {
  for (const key of ['source', 'destination'] as const) {
    const override = overrides[key]
    if (!override) continue
    const connectorName = override.type as string
    const overrideConfig = override[connectorName] as Record<string, unknown>
    const existing =
      (pipeline[key] as Record<string, unknown>)?.[connectorName] ?? {}

    // Validate override keys against the spec schema or existing config
    const knownKeys = specSchemas?.[key]
      ? new Set(Object.keys(specSchemas[key]!))
      : new Set(Object.keys(existing as Record<string, unknown>))
    if (knownKeys.size > 0) {
      for (const k of Object.keys(overrideConfig)) {
        if (!knownKeys.has(k)) {
          throw new Error(
            `Unknown ${key} config key --${connectorName}.${k}. ` +
              `Known keys: ${[...knownKeys].join(', ')}`
          )
        }
      }
    }

    pipeline[key] = {
      ...(pipeline[key] as Record<string, unknown>),
      type: connectorName,
      [connectorName]: {
        ...(existing as Record<string, unknown>),
        ...overrideConfig,
      },
    }
  }
}

export function assertNoDottedUnknownFlags(
  args: Record<string, unknown>,
  knownConnectors: string[]
) {
  const known = new Set(knownConnectors.map(normalizeCliKey))
  for (const rawKey of Object.keys(args)) {
    const dotIndex = rawKey.indexOf('.')
    if (dotIndex === -1) continue
    const prefix = normalizeCliKey(rawKey.slice(0, dotIndex))
    if (!known.has(prefix)) {
      throw new Error(
        `Unknown connector flag --${rawKey}: "${prefix}" is not a known connector. ` +
          `Available connectors: ${knownConnectors.join(', ')}`
      )
    }
  }
}

export function assertNoAmbiguousConnectorNames(sources: string[], destinations: string[]) {
  const sourceNames = new Map(sources.map((name) => [normalizeCliKey(name), name]))
  const overlaps = destinations
    .filter((name) => sourceNames.has(normalizeCliKey(name)))
    .map((name) => `${sourceNames.get(normalizeCliKey(name))} / ${name}`)

  if (overlaps.length > 0) {
    throw new Error(
      `Connector names cannot exist in both source and destination sets: ${overlaps.join(', ')}`
    )
  }
}

export function wrapPipelineConnectorShorthand(
  command: CommandDef,
  options: { sources: string[]; destinations: string[] }
): CommandDef {
  assertNoAmbiguousConnectorNames(options.sources, options.destinations)

  const args = { ...((command.args ?? {}) as Record<string, unknown>) } as Record<string, any>
  if (args.source && typeof args.source === 'object') {
    args.source = { ...args.source, required: false }
  }
  if (args.destination && typeof args.destination === 'object') {
    args.destination = { ...args.destination, required: false }
  }
  args['x-pipeline'] = {
    type: 'string',
    required: false,
    description: 'Full pipeline config as inline JSON or path to a JSON file',
  }
  // Override the auto-generated skipCheck (camelCase string) with kebab-case boolean
  delete args['skipCheck']
  args['skip-check'] = {
    type: 'boolean',
    default: false,
    description: 'Skip connector validation checks',
  }

  return defineCommand({
    ...command,
    args,
    async run(input) {
      let resolvedArgs = input.args as Record<string, unknown>

      // --skip-check → dispatch expects skipCheck (the toOptName key for skip_check)
      if (resolvedArgs['skip-check']) {
        resolvedArgs = { ...resolvedArgs, skipCheck: 'true' }
      }

      // --x-pipeline provides the full PipelineConfig (same format as the engine's
      // X-Pipeline header): { source: { type, [type]: {...} }, destination: {...}, streams?: [...] }
      const xPipeline = resolvedArgs['x-pipeline'] as string | undefined
      if (xPipeline) {
        const { parseJsonOrFile } = await import('@stripe/sync-ts-cli')
        const pipelineConfig = parseJsonOrFile(xPipeline)
        // Map PipelineConfig fields to the service body fields
        if (pipelineConfig.source && resolvedArgs.source === undefined) {
          resolvedArgs = { ...resolvedArgs, source: JSON.stringify(pipelineConfig.source) }
        }
        if (pipelineConfig.destination && resolvedArgs.destination === undefined) {
          resolvedArgs = { ...resolvedArgs, destination: JSON.stringify(pipelineConfig.destination) }
        }
        if (pipelineConfig.streams && resolvedArgs.streams === undefined) {
          resolvedArgs = { ...resolvedArgs, streams: JSON.stringify(pipelineConfig.streams) }
        }
      }

      assertNoDottedUnknownFlags(resolvedArgs, [...options.sources, ...options.destinations])
      const argsWithSource = applyConnectorShorthand(resolvedArgs, 'source', options.sources)
      const argsWithDestination = applyConnectorShorthand(
        argsWithSource,
        'destination',
        options.destinations
      )
      return command.run?.({ ...input, args: argsWithDestination as any })
    },
  })
}
