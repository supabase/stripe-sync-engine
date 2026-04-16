import {
  BUNDLED_API_VERSION,
  discoverListEndpoints,
  isV2Path,
  resolveOpenApiSpec,
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  parsedTableToJsonSchema,
  type ListEndpoint,
  type OpenApiOperationObject,
  type OpenApiSchemaObject,
  type OpenApiSchemaOrReference,
  type OpenApiSpec,
} from '@stripe/sync-openapi'

const SCHEMA_REF_PREFIX = '#/components/schemas/'

export type EndpointQueryParam = {
  name: string
  required: boolean
  schema?: OpenApiSchemaObject
}

export type EndpointDefinition = ListEndpoint & {
  isV2: boolean
  queryParams: EndpointQueryParam[]
  jsonSchema?: Record<string, unknown>
}

export type ResolvedEndpointSet = {
  apiVersion: string
  spec: OpenApiSpec
  endpoints: Map<string, EndpointDefinition>
}

export async function resolveEndpointSet(options: {
  apiVersion?: string
  openApiSpecPath?: string
  cacheDir?: string
  fetchImpl?: typeof globalThis.fetch
}): Promise<ResolvedEndpointSet> {
  const apiVersion = options.apiVersion ?? BUNDLED_API_VERSION
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const resolved = await resolveOpenApiSpec(
    {
      apiVersion,
      openApiSpecPath: options.openApiSpecPath,
      cacheDir: options.cacheDir,
    },
    fetchImpl
  )

  const discovered = discoverListEndpoints(resolved.spec)

  const jsonSchemaMap = new Map<string, Record<string, unknown>>()
  try {
    const parser = new SpecParser()
    const parsed = parser.parse(resolved.spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    for (const table of parsed.tables) {
      jsonSchemaMap.set(table.tableName, parsedTableToJsonSchema(table))
    }
  } catch {
    // fall through without schemas when the spec can't be parsed
  }

  const endpoints = new Map<string, EndpointDefinition>()

  for (const [tableName, endpoint] of discovered.entries()) {
    const operation = resolved.spec.paths?.[endpoint.apiPath]?.get
    endpoints.set(tableName, {
      ...endpoint,
      isV2: isV2Path(endpoint.apiPath),
      queryParams: extractQueryParams(operation, resolved.spec),
      jsonSchema: jsonSchemaMap.get(tableName),
    })
  }

  return {
    apiVersion: resolved.apiVersion,
    spec: resolved.spec,
    endpoints,
  }
}

function extractQueryParams(
  operation: OpenApiOperationObject | undefined,
  spec: OpenApiSpec
): EndpointQueryParam[] {
  if (!operation?.parameters) return []
  const params: EndpointQueryParam[] = []
  for (const param of operation.parameters) {
    if (param.in !== 'query' || !param.name) continue
    const schema = param.schema ? resolveSchema(param.schema, spec) : undefined
    params.push({
      name: param.name,
      required: Boolean(param.required),
      schema,
    })
  }
  return params
}

function resolveSchema(
  schemaOrRef: OpenApiSchemaOrReference,
  spec: OpenApiSpec,
  seenRefs = new Set<string>()
): OpenApiSchemaObject | undefined {
  if ('$ref' in schemaOrRef) {
    if (!schemaOrRef.$ref.startsWith(SCHEMA_REF_PREFIX)) return undefined
    if (seenRefs.has(schemaOrRef.$ref)) return undefined
    seenRefs.add(schemaOrRef.$ref)
    const schemaName = schemaOrRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const resolved = spec.components?.schemas?.[schemaName]
    if (!resolved) return undefined
    return resolveSchema(resolved, spec, seenRefs)
  }

  const schema: OpenApiSchemaObject = { ...schemaOrRef }
  if (schema.properties) {
    const nextProperties: Record<string, OpenApiSchemaOrReference> = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      nextProperties[key] = resolveSchema(value, spec, new Set(seenRefs)) ?? value
    }
    schema.properties = nextProperties
  }
  if (schema.items) {
    schema.items = resolveSchema(schema.items, spec, new Set(seenRefs)) ?? schema.items
  }
  if (schema.oneOf) {
    schema.oneOf = schema.oneOf.map(
      (candidate) => resolveSchema(candidate, spec, new Set(seenRefs)) ?? candidate
    )
  }
  if (schema.anyOf) {
    schema.anyOf = schema.anyOf.map(
      (candidate) => resolveSchema(candidate, spec, new Set(seenRefs)) ?? candidate
    )
  }
  if (schema.allOf) {
    schema.allOf = schema.allOf.map(
      (candidate) => resolveSchema(candidate, spec, new Set(seenRefs)) ?? candidate
    )
  }
  return schema
}
