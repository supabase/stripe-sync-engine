import type { ConnectorResolver } from '../lib/index.js'

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
 * Walk an OpenAPI spec and add `discriminator: { propertyName: "type" }` to
 * every `oneOf` whose variants all define a `type` property with a single enum
 * or const value. Handles both Zod v3 (enum) and Zod v4 (const) output.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addDiscriminators(node: any): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) addDiscriminators(item)
    return
  }
  if (Array.isArray(node.oneOf)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allHaveTypeDiscriminator = node.oneOf.every(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v: any) =>
        v?.type === 'object' &&
        (v?.properties?.type?.enum?.length === 1 || v?.properties?.type?.const !== undefined)
    )
    if (allHaveTypeDiscriminator && !node.discriminator) {
      node.discriminator = { propertyName: 'type' }
    }
  }
  for (const value of Object.values(node)) {
    addDiscriminators(value)
  }
}

// ── Connector schema injection ───────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function connectorSchemaName(name: string, role: 'Source' | 'Destination'): string {
  const pascal = name
    .split(/[-_]/)
    .map((w) => capitalize(w))
    .join('')
  return `${pascal}${role}Config`
}

/**
 * Inject typed connector config schemas into an OpenAPI spec's components,
 * building SourceConfig / DestinationConfig discriminated unions and a
 * PipelineConfig wrapper. Also annotates x-pipeline / x-state header params
 * with contentMediaType + contentSchema for OAS 3.1.
 *
 * Mutates `spec` in place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function injectConnectorSchemas(spec: any, resolver: ConnectorResolver): void {
  if (!spec.components) spec.components = {}
  if (!spec.components.schemas) spec.components.schemas = {}

  for (const [name, r] of resolver.sources()) {
    const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
    schema.properties = { type: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
    schema.required = ['type', ...(schema.required ?? [])]
    spec.components.schemas[connectorSchemaName(name, 'Source')] = schema
  }

  for (const [name, r] of resolver.destinations()) {
    const schema = JSON.parse(JSON.stringify(r.rawConfigJsonSchema))
    schema.properties = { type: { type: 'string', enum: [name] }, ...(schema.properties ?? {}) }
    schema.required = ['type', ...(schema.required ?? [])]
    spec.components.schemas[connectorSchemaName(name, 'Destination')] = schema
  }

  const sourceNames = [...resolver.sources().keys()]
  if (sourceNames.length > 0) {
    spec.components.schemas['SourceConfig'] = {
      discriminator: { propertyName: 'type' },
      oneOf: sourceNames.map((n) => ({
        $ref: `#/components/schemas/${connectorSchemaName(n, 'Source')}`,
      })),
    }
  }

  const destNames = [...resolver.destinations().keys()]
  if (destNames.length > 0) {
    spec.components.schemas['DestinationConfig'] = {
      discriminator: { propertyName: 'type' },
      oneOf: destNames.map((n) => ({
        $ref: `#/components/schemas/${connectorSchemaName(n, 'Destination')}`,
      })),
    }
  }

  spec.components.schemas['PipelineConfig'] = {
    type: 'object',
    required: ['source', 'destination'],
    properties: {
      source:
        sourceNames.length > 0
          ? { $ref: '#/components/schemas/SourceConfig' }
          : {
              type: 'object',
              required: ['type'],
              properties: { type: { type: 'string' } },
              additionalProperties: true,
            },
      destination:
        destNames.length > 0
          ? { $ref: '#/components/schemas/DestinationConfig' }
          : {
              type: 'object',
              required: ['type'],
              properties: { type: { type: 'string' } },
              additionalProperties: true,
            },
      streams: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            sync_mode: { type: 'string', enum: ['incremental', 'full_refresh'] },
            fields: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  }

  // Annotate JSON-encoded headers with contentMediaType / contentSchema (OAS 3.1)
  for (const [, methods] of Object.entries(spec.paths ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const [, op] of Object.entries(methods as Record<string, any>)) {
      for (const param of op?.parameters ?? []) {
        if (param.in !== 'header') continue
        if (param.name === 'x-pipeline') {
          param.schema = {
            type: 'string',
            contentMediaType: 'application/json',
            contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
          }
        } else if (param.name === 'x-state') {
          param.schema = {
            type: 'string',
            contentMediaType: 'application/json',
            contentSchema: {
              type: 'object',
              additionalProperties: true,
              description: 'Per-stream cursor state keyed by stream name',
            },
          }
        }
      }
    }
  }
}
