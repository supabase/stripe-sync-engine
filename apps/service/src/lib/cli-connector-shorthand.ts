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

  return defineCommand({
    ...command,
    args,
    async run(input) {
      let resolvedArgs = input.args as Record<string, unknown>

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
