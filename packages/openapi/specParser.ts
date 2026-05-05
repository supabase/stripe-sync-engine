import type {
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiSpec,
  ParseSpecOptions,
  ParsedColumn,
  ParsedOpenApiSpec,
  ScalarType,
} from './types.js'
import { OPENAPI_RESOURCE_TABLE_ALIASES } from './runtimeMappings.js'

const SCHEMA_REF_PREFIX = '#/components/schemas/'
const CRUD_SUFFIXES = ['.created', '.updated', '.deleted'] as const

const RESERVED_COLUMNS = new Set([
  'id',
  '_raw_data',
  '_synced_at',
  '_last_synced_at',
  '_updated_at',
  '_account_id',
  'deleted',
])

export { OPENAPI_RESOURCE_TABLE_ALIASES }

/**
 * Resolve a Stripe x-resourceId to a canonical table name.
 * Singular, snake_cased, with version namespace dots converted to underscores.
 */
export function resolveTableName(
  resourceId: string,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): string {
  const alias = aliases[resourceId]
  if (alias) return alias
  return resourceId.toLowerCase().replace(/[.]/g, '_')
}

/** A list endpoint at a top-level path (`/v1/customers`). */
export type ListEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  supportsCreatedFilter: boolean
  supportsLimit: boolean
  supportsStartingAfter: boolean
  supportsEndingBefore: boolean
}

/** A nested list endpoint at a parent-scoped path (`/v1/customers/{id}/cards`). */
export type NestedEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  parentTableName: string
  parentParamName: string
  supportsPagination: boolean
}

type ColumnAccumulator = {
  type: ScalarType
  nullable: boolean
  expandableReference: boolean
}

/** One normalized record per discovered list-shaped GET endpoint. */
type RawListPath = {
  apiPath: string
  isNested: boolean
  resourceId: string
  schemaName: string
  parameters: ReadonlyArray<{ name?: string; in?: string; required?: boolean }>
}

const PAGINATION_PARAMS = new Set(['limit', 'starting_after', 'ending_before', 'created', 'expand'])

function hasParam(
  parameters: ReadonlyArray<{ name?: string; in?: string }>,
  name: string
): boolean {
  return parameters.some((p) => p.name === name && p.in === 'query')
}

function hasNonPaginationRequiredQueryParam(
  parameters: ReadonlyArray<{ name?: string; in?: string; required?: boolean }>
): boolean {
  return parameters.some(
    (p) => p.required === true && p.in === 'query' && !PAGINATION_PARAMS.has(p.name ?? '')
  )
}

export class SpecParser {
  parse(spec: OpenApiSpec, options: ParseSpecOptions = {}): ParsedOpenApiSpec {
    const schemas = spec.components?.schemas
    if (!schemas || typeof schemas !== 'object') {
      throw new Error('OpenAPI spec is missing components.schemas')
    }

    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.resourceAliases ?? {}) }
    const excluded = new Set(options.excludedTables ?? [])
    const allowedTables = options.allowedTables
      ? new Set(options.allowedTables.filter((t) => !excluded.has(t)))
      : this.discoverAllowedTables(spec, aliases, excluded)
    const tableMap = new Map<
      string,
      {
        resourceId: string
        sourceSchemaName: string
        columns: Map<string, ColumnAccumulator>
      }
    >()

    for (const schemaName of Object.keys(schemas).sort((a, b) => a.localeCompare(b))) {
      const schema = this.resolveSchema({ $ref: `#/components/schemas/${schemaName}` }, spec)
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }

      const tableName = resolveTableName(resourceId, aliases)
      if (!allowedTables.has(tableName)) {
        continue
      }

      const propCandidates = this.collectPropertyCandidates(
        { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const parsedColumns = this.parseColumns(propCandidates, spec)

      const existing =
        tableMap.get(tableName) ??
        ({
          resourceId,
          sourceSchemaName: schemaName,
          columns: new Map<string, ColumnAccumulator>(),
        } as const)

      for (const column of parsedColumns) {
        const current = existing.columns.get(column.name)
        if (!current) {
          existing.columns.set(column.name, {
            type: column.type,
            nullable: column.nullable,
            expandableReference: column.expandableReference ?? false,
          })
          continue
        }
        existing.columns.set(column.name, {
          type: this.mergeTypes(current.type, column.type),
          nullable: current.nullable || column.nullable,
          expandableReference: current.expandableReference || (column.expandableReference ?? false),
        })
      }

      tableMap.set(tableName, existing)
    }

    const tables = Array.from(tableMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, table]) => ({
        tableName,
        resourceId: table.resourceId,
        sourceSchemaName: table.sourceSchemaName,
        columns: Array.from(table.columns.entries())
          .map(([name, value]) => ({
            name,
            type: value.type,
            nullable: value.nullable,
            ...(value.expandableReference ? { expandableReference: true } : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))

    return {
      apiVersion: spec.info?.version ?? spec.openapi ?? 'unknown',
      tables,
    }
  }

  /**
   * Parse the spec restricted to syncable tables only.
   * Combines discoverSyncableTables + parse into a single call.
   */
  parseSyncable(
    spec: OpenApiSpec,
    options: {
      aliases?: Record<string, string>
      excluded?: ReadonlySet<string>
    } = {}
  ): ParsedOpenApiSpec {
    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.aliases ?? {}) }
    const syncableTables = this.discoverSyncableTables(spec, {
      aliases,
      excluded: options.excluded,
    })
    return this.parse(spec, {
      resourceAliases: aliases,
      allowedTables: Array.from(syncableTables),
    })
  }

  /**
   * The canonical list of tables that can be synced from this spec.
   * Syncable = listable + webhook-updatable + not excluded.
   */
  discoverSyncableTables(
    spec: OpenApiSpec,
    options: {
      aliases?: Record<string, string>
      excluded?: ReadonlySet<string>
    } = {}
  ): Set<string> {
    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.aliases ?? {}) }
    const excluded = options.excluded ?? new Set<string>()
    const listableIds = this.discoverListableResourceIds(spec, { includeNested: true })
    const webhookIds = this.discoverWebhookUpdatableResourceIds(spec, listableIds)
    const tables = new Set<string>()
    for (const resourceId of listableIds) {
      if (!webhookIds.has(resourceId)) continue
      const tableName = resolveTableName(resourceId, aliases)
      if (!excluded.has(tableName)) tables.add(tableName)
    }
    return tables
  }

  /**
   * Discover top-level list endpoints (e.g. `/v1/customers`) and extract their
   * runtime metadata (apiPath, capability flags). Excludes endpoints requiring
   * non-pagination query parameters at runtime.
   */
  discoverListEndpoints(
    spec: OpenApiSpec,
    aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
  ): Map<string, ListEndpoint> {
    const endpoints = new Map<string, ListEndpoint>()
    for (const raw of this.iterListPaths(spec)) {
      if (raw.isNested) continue
      const tableName = resolveTableName(raw.resourceId, aliases)
      if (endpoints.has(tableName)) continue
      if (hasNonPaginationRequiredQueryParam(raw.parameters)) continue

      endpoints.set(tableName, {
        tableName,
        resourceId: raw.resourceId,
        apiPath: raw.apiPath,
        supportsCreatedFilter: hasParam(raw.parameters, 'created'),
        supportsLimit: hasParam(raw.parameters, 'limit'),
        supportsStartingAfter: hasParam(raw.parameters, 'starting_after'),
        supportsEndingBefore: hasParam(raw.parameters, 'ending_before'),
      })
    }
    return endpoints
  }

  /**
   * Discover nested list endpoints (e.g. `/v1/customers/{id}/cards`) and link
   * each to its parent resource. Endpoints whose parent path isn't in
   * `topLevelEndpoints` are skipped.
   */
  discoverNestedEndpoints(
    spec: OpenApiSpec,
    topLevelEndpoints: Map<string, ListEndpoint>,
    aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
  ): NestedEndpoint[] {
    const topLevelByPath = new Map<string, ListEndpoint>()
    for (const endpoint of topLevelEndpoints.values()) {
      topLevelByPath.set(endpoint.apiPath, endpoint)
    }

    const nested: NestedEndpoint[] = []
    for (const raw of this.iterListPaths(spec)) {
      if (!raw.isNested) continue
      const paramMatch = raw.apiPath.match(/\{([^}]+)\}/)
      if (!paramMatch) continue
      const parentPath = raw.apiPath.slice(0, raw.apiPath.indexOf('/{'))
      const parent = topLevelByPath.get(parentPath)
      if (!parent) continue

      nested.push({
        tableName: resolveTableName(raw.resourceId, aliases),
        resourceId: raw.resourceId,
        apiPath: raw.apiPath,
        parentTableName: parent.tableName,
        parentParamName: paramMatch[1]!,
        supportsPagination: hasParam(raw.parameters, 'limit'),
      })
    }
    return nested
  }

  /**
   * Resolve the canonical table list for schema parsing.
   * Delegates to {@link discoverSyncableTables} so the parser and runtime
   * registry agree on what is syncable.
   */
  private discoverAllowedTables(
    spec: OpenApiSpec,
    aliases: Record<string, string>,
    excluded: Set<string>
  ): Set<string> {
    return this.discoverSyncableTables(spec, { aliases, excluded })
  }

  /**
   * Extract x-resourceId values for every schema returned by a list endpoint.
   * Supports both v1 (object: "list") and v2 (next_page_url) formats.
   */
  discoverListableResourceIds(
    spec: OpenApiSpec,
    options: { includeNested: boolean } = { includeNested: false }
  ): Set<string> {
    const resourceIds = new Set<string>()
    for (const raw of this.iterListPaths(spec)) {
      if (!options.includeNested && raw.isNested) continue
      resourceIds.add(raw.resourceId)
    }
    return resourceIds
  }

  /**
   * Walk `spec.paths` and yield one normalized record per GET endpoint whose
   * 200 response matches the Stripe list shape (`{ data: [...], object: "list" }`
   * or v2 `{ data: [...], next_page_url }`). Shared by every path-discovery
   * method on this class so they can't disagree.
   */
  private *iterListPaths(spec: OpenApiSpec): Generator<RawListPath> {
    const paths = spec.paths
    if (!paths) return

    for (const [apiPath, pathItem] of Object.entries(paths)) {
      const getOp = pathItem.get
      if (!getOp?.responses) continue

      const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
      if (!responseSchema) continue
      if (!this.isListResponseSchema(responseSchema)) continue

      const dataProp = responseSchema.properties?.data
      if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

      const itemsRef = dataProp.items
      if (!itemsRef || !this.isReference(itemsRef)) continue
      if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

      const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
      const schema = spec.components?.schemas?.[schemaName]
      if (!schema || '$ref' in schema) continue

      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') continue

      yield {
        apiPath,
        isNested: apiPath.includes('{'),
        resourceId,
        schemaName,
        parameters: getOp.parameters ?? [],
      }
    }
  }

  /**
   * Resource IDs that have at least one CRUD webhook event.
   * Merges three signals so v1 and v2 specs both work:
   *  - `x-stripeEvent` schemas with `properties.object.$ref` (v1 events)
   *  - `x-stripeEvent.type` prefix matched against listable ids (v2 events)
   *  - `paths['/v1/webhook_endpoints'].post...enabled_events` enum (older/public specs)
   */
  discoverWebhookUpdatableResourceIds(
    spec: OpenApiSpec,
    listableIds?: ReadonlySet<string>
  ): Set<string> {
    const ids = listableIds ?? this.discoverListableResourceIds(spec, { includeNested: true })
    const eventTypes = new Set<string>([
      ...this.collectStripeEventTypes(spec),
      ...this.collectEnabledEventTypes(spec),
    ])
    const fromTypes = this.matchEventTypesToResourceIds(eventTypes, ids)
    const fromRef = this.discoverWebhookUpdatableFromExtension(spec)
    return new Set<string>([...fromTypes, ...fromRef])
  }

  private discoverWebhookUpdatableFromExtension(spec: OpenApiSpec): Set<string> {
    const resourceIds = new Set<string>()
    const schemas = spec.components?.schemas
    if (!schemas) return resourceIds

    for (const schema of Object.values(schemas)) {
      if (!schema || '$ref' in schema) continue

      const stripeEvent = schema['x-stripeEvent']
      if (!stripeEvent || typeof stripeEvent !== 'object') continue

      const eventType = stripeEvent.type
      if (!eventType || !CRUD_SUFFIXES.some((suffix) => eventType.endsWith(suffix))) continue

      const objectProp = schema.properties?.object
      if (!objectProp || !this.isReference(objectProp)) continue
      if (!objectProp.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

      const schemaName = objectProp.$ref.slice(SCHEMA_REF_PREFIX.length)
      const refSchema = schemas[schemaName]
      if (!refSchema || '$ref' in refSchema) continue

      const resourceId = refSchema['x-resourceId']
      if (resourceId && typeof resourceId === 'string') {
        resourceIds.add(resourceId)
      }
    }

    return resourceIds
  }

  private collectStripeEventTypes(spec: OpenApiSpec): Set<string> {
    const types = new Set<string>()
    const schemas = spec.components?.schemas
    if (!schemas) return types
    for (const schema of Object.values(schemas)) {
      if (!schema || '$ref' in schema) continue
      const stripeEvent = schema['x-stripeEvent']
      if (!stripeEvent || typeof stripeEvent !== 'object') continue
      const eventType = stripeEvent.type
      if (eventType && typeof eventType === 'string') types.add(eventType)
    }
    return types
  }

  private collectEnabledEventTypes(spec: OpenApiSpec): Set<string> {
    const types = new Set<string>()
    const op = spec.paths?.['/v1/webhook_endpoints']?.post as
      | { requestBody?: { content?: Record<string, { schema?: OpenApiSchemaOrReference }> } }
      | undefined
    const schema = op?.requestBody?.content?.['application/x-www-form-urlencoded']?.schema
    if (!schema || '$ref' in schema) return types
    const enabledEvents = schema.properties?.enabled_events
    if (!enabledEvents || '$ref' in enabledEvents) return types
    const items = enabledEvents.items
    if (!items || Array.isArray(items) || '$ref' in items) return types
    const enumValues = items.enum
    if (!Array.isArray(enumValues)) return types
    for (const value of enumValues) {
      if (typeof value === 'string') types.add(value)
    }
    return types
  }

  /** Match event types like `customer.created` or `v2.core.account.updated` against listable resource ids. */
  private matchEventTypesToResourceIds(
    eventTypes: ReadonlySet<string>,
    listableIds: ReadonlySet<string>
  ): Set<string> {
    const out = new Set<string>()
    if (eventTypes.size === 0) return out
    const candidatePrefixes = new Set<string>()
    for (const type of eventTypes) {
      const cleaned = type.replace(/\[[^\]]*\]/g, '')
      const lastDot = cleaned.lastIndexOf('.')
      if (lastDot <= 0) continue
      candidatePrefixes.add(cleaned.slice(0, lastDot))
    }
    for (const resourceId of listableIds) {
      if (candidatePrefixes.has(resourceId)) {
        out.add(resourceId)
        continue
      }
      const suffix = `.${resourceId}`
      for (const prefix of candidatePrefixes) {
        if (prefix.endsWith(suffix)) {
          out.add(resourceId)
          break
        }
      }
    }
    return out
  }

  /**
   * Detect whether a response schema describes a list endpoint.
   * v1 lists have `object: enum ["list"]` with a `data` array.
   * v2 lists have a `data` array with `next_page_url`.
   */
  private isListResponseSchema(schema: OpenApiSchemaObject): boolean {
    const dataProp = schema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') return false

    const objectProp = schema.properties?.object
    if (objectProp && 'enum' in objectProp && objectProp.enum?.includes('list')) return true

    if (schema.properties?.next_page_url) return true

    return false
  }

  /**
   * Detect whether a property schema is a list envelope.
   * List envelopes ({data, has_more, url, object: "list"}) are transport wrappers,
   * not part of the parent row shape per rule #9 of the schema spec.
   */
  private isListEnvelopeSchema(schema: OpenApiSchemaObject): boolean {
    const dataProp = schema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') return false

    const objectProp = schema.properties?.object
    if (objectProp && 'enum' in objectProp && objectProp.enum?.includes('list')) return true

    if (schema.properties?.next_page_url) return true

    return false
  }

  /**
   * Detect whether a composition (oneOf/anyOf/allOf) contains only list envelope schemas.
   * If all branches are list envelopes, the entire property should be excluded.
   */
  private isListEnvelopeInComposition(
    schema: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): boolean {
    if (this.isReference(schema)) {
      return false
    }

    const compositions: (OpenApiSchemaOrReference[] | undefined)[] = [
      schema.oneOf,
      schema.anyOf,
      schema.allOf,
    ]
    for (const composed of compositions) {
      if (!composed) continue
      const resolved = composed.map((s) => (this.isReference(s) ? this.resolveSchema(s, spec) : s))
      if (resolved.length > 0 && resolved.every((s) => this.isListEnvelopeSchema(s))) {
        return true
      }
    }
    return false
  }

  private parseColumns(
    propCandidates: Map<string, OpenApiSchemaOrReference[]>,
    spec: OpenApiSpec
  ): ParsedColumn[] {
    const columns: ParsedColumn[] = []
    for (const [propertyName, candidates] of Array.from(propCandidates.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (RESERVED_COLUMNS.has(propertyName)) {
        continue
      }
      const inferred = this.inferFromCandidates(candidates, spec)
      columns.push({
        name: propertyName,
        type: inferred.type,
        nullable: inferred.nullable,
        ...(inferred.expandableReference ? { expandableReference: true } : {}),
      })
    }
    return columns
  }

  private inferFromCandidates(
    candidates: OpenApiSchemaOrReference[],
    spec: OpenApiSpec
  ): { type: ScalarType; nullable: boolean; expandableReference: boolean } {
    if (candidates.length === 0) {
      return { type: 'text', nullable: true, expandableReference: false }
    }

    let mergedType: ScalarType | null = null
    let nullable = false
    let expandableReference = false
    for (const candidate of candidates) {
      const inferred = this.inferType(candidate, spec)
      mergedType = mergedType ? this.mergeTypes(mergedType, inferred.type) : inferred.type
      nullable = nullable || inferred.nullable
      expandableReference =
        expandableReference || this.isExpandableReferenceCandidate(candidate, spec)
    }

    return { type: mergedType ?? 'text', nullable, expandableReference }
  }

  private mergeTypes(left: ScalarType, right: ScalarType): ScalarType {
    if (left === right) return left
    if (left === 'json' || right === 'json') return 'json'
    if ((left === 'numeric' && right === 'bigint') || (left === 'bigint' && right === 'numeric')) {
      return 'numeric'
    }
    if (left === 'timestamptz' && right === 'text') return 'text'
    if (left === 'text' && right === 'timestamptz') return 'text'
    return 'text'
  }

  private inferType(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): { type: ScalarType; nullable: boolean } {
    const schema = this.resolveSchema(schemaOrRef, spec)
    const nullable = Boolean(schema.nullable)

    if (schema.oneOf?.length) {
      const merged = this.inferFromCandidates(schema.oneOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.anyOf?.length) {
      const merged = this.inferFromCandidates(schema.anyOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }
    if (schema.allOf?.length) {
      const merged = this.inferFromCandidates(schema.allOf, spec)
      return { type: merged.type, nullable: nullable || merged.nullable }
    }

    if (schema.type === 'boolean') return { type: 'boolean', nullable }
    if (schema.type === 'integer') return { type: 'bigint', nullable }
    if (schema.type === 'number') return { type: 'numeric', nullable }
    if (schema.type === 'string') {
      if (schema.format === 'date-time') {
        return { type: 'timestamptz', nullable }
      }
      return { type: 'text', nullable }
    }
    if (schema.type === 'array') return { type: 'json', nullable }
    if (schema.type === 'object') return { type: 'json', nullable }
    if (schema.properties || schema.additionalProperties) return { type: 'json', nullable }

    if (schema.enum && schema.enum.length > 0) {
      const values = schema.enum
      if (values.every((value) => typeof value === 'boolean')) {
        return { type: 'boolean', nullable }
      }
      if (values.every((value) => typeof value === 'number' && Number.isInteger(value))) {
        return { type: 'bigint', nullable }
      }
      if (values.every((value) => typeof value === 'number')) {
        return { type: 'numeric', nullable }
      }
    }

    return { type: 'text', nullable: true }
  }

  private isExpandableReferenceCandidate(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): boolean {
    const schema = this.resolveSchema(schemaOrRef, spec)
    return Boolean(schema['x-expansionResources'])
  }

  private collectPropertyCandidates(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>()
  ): Map<string, OpenApiSchemaOrReference[]> {
    if (this.isReference(schemaOrRef)) {
      if (seenRefs.has(schemaOrRef.$ref)) {
        return new Map()
      }
      seenRefs.add(schemaOrRef.$ref)
    }

    const schema = this.resolveSchema(schemaOrRef, spec)
    if (seenSchemas.has(schema)) {
      return new Map()
    }
    seenSchemas.add(schema)

    const merged = new Map<string, OpenApiSchemaOrReference[]>()
    const pushProp = (name: string, value: OpenApiSchemaOrReference) => {
      const existing = merged.get(name) ?? []
      existing.push(value)
      merged.set(name, existing)
    }

    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      if (this.isReference(value)) {
        const resolved = this.resolveSchema(value, spec)
        if (this.isListEnvelopeSchema(resolved)) continue
      } else if ('type' in value && value.type === 'object' && this.isListEnvelopeSchema(value)) {
        continue
      } else if (this.isListEnvelopeInComposition(value, spec)) {
        continue
      }
      pushProp(name, value)
    }

    for (const composed of [schema.allOf, schema.oneOf, schema.anyOf]) {
      if (!composed) continue
      for (const subSchema of composed) {
        if (this.isReference(subSchema)) {
          const resolved = this.resolveSchema(subSchema, spec)
          if (this.isListEnvelopeSchema(resolved)) continue
        } else if (
          'type' in subSchema &&
          subSchema.type === 'object' &&
          this.isListEnvelopeSchema(subSchema)
        ) {
          continue
        } else if (this.isListEnvelopeInComposition(subSchema, spec)) {
          continue
        }
        const subProps = this.collectPropertyCandidates(subSchema, spec, seenRefs, seenSchemas)
        for (const [name, candidates] of subProps.entries()) {
          for (const candidate of candidates) {
            pushProp(name, candidate)
          }
        }
      }
    }

    return merged
  }

  private resolveSchema(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): OpenApiSchemaObject {
    if (!this.isReference(schemaOrRef)) {
      return schemaOrRef
    }

    if (!schemaOrRef.$ref.startsWith(SCHEMA_REF_PREFIX)) {
      throw new Error(`Unsupported OpenAPI reference: ${schemaOrRef.$ref}`)
    }
    const schemaName = schemaOrRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const resolved = spec.components?.schemas?.[schemaName]
    if (!resolved) {
      throw new Error(`Failed to resolve OpenAPI schema reference: ${schemaOrRef.$ref}`)
    }
    if (this.isReference(resolved)) {
      return this.resolveSchema(resolved, spec)
    }
    return resolved
  }

  private isReference(schemaOrRef: OpenApiSchemaOrReference): schemaOrRef is { $ref: string } {
    return typeof (schemaOrRef as { $ref?: string }).$ref === 'string'
  }
}
