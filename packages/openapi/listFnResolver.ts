import type { OpenApiSchemaObject, OpenApiSpec } from './types.js'
import { OPENAPI_RESOURCE_TABLE_ALIASES } from './runtimeMappings.js'

const SCHEMA_REF_PREFIX = '#/components/schemas/'

export type ListParams = {
  limit?: number
  starting_after?: string
  ending_before?: string
  created?: { gt?: number; gte?: number; lt?: number; lte?: number }
}

export type ListResult = { data: unknown[]; has_more: boolean; pageCursor?: string }

export type ListFn = (params: ListParams) => Promise<ListResult>

export type RetrieveFn = (id: string) => Promise<unknown>

export type ListEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  supportsCreatedFilter: boolean
  supportsLimit: boolean
}

export type NestedEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  parentTableName: string
  parentParamName: string
  supportsPagination: boolean
}

export function resolveTableName(resourceId: string, aliases: Record<string, string>): string {
  const alias = aliases[resourceId]
  if (alias) return alias
  const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
  return normalized.endsWith('s') ? normalized : `${normalized}s`
}

/**
 * Detect whether a response schema describes a list endpoint.
 * v1 lists have `object: enum ["list"]` with a `data` array.
 * v2 lists have a `data` array with `next_page_url`.
 */
function isListResponseSchema(schema: OpenApiSchemaObject): boolean {
  const dataProp = schema.properties?.data
  if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') return false

  const objectProp = schema.properties?.object
  if (objectProp && 'enum' in objectProp && objectProp.enum?.includes('list')) return true

  if (schema.properties?.next_page_url) return true

  return false
}

/**
 * Scan the spec for list endpoints (GET paths that return a Stripe list object)
 * and return one entry per table. Prefers top-level paths over nested ones.
 * Supports both v1 (object: "list") and v2 (next_page_url) response formats.
 */
export function discoverListEndpoints(
  spec: OpenApiSpec,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): Map<string, ListEndpoint> {
  const endpoints = new Map<string, ListEndpoint>()
  const paths = spec.paths
  if (!paths) return endpoints

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    if (!isListResponseSchema(responseSchema)) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const tableName = resolveTableName(resourceId, aliases)
    if (!endpoints.has(tableName)) {
      const params = getOp.parameters ?? []
      const PAGINATION_PARAMS = new Set([
        'limit',
        'starting_after',
        'ending_before',
        'created',
        'expand',
      ])
      const hasRequiredQueryParams = params.some(
        (p: { name?: string; in?: string; required?: boolean }) =>
          p.required === true && p.in === 'query' && !PAGINATION_PARAMS.has(p.name ?? '')
      )
      if (hasRequiredQueryParams) continue

      const supportsCreatedFilter = params.some(
        (p: { name?: string; in?: string }) => p.name === 'created' && p.in === 'query'
      )
      const supportsLimit = params.some(
        (p: { name?: string; in?: string }) => p.name === 'limit' && p.in === 'query'
      )
      endpoints.set(tableName, {
        tableName,
        resourceId,
        apiPath,
        supportsCreatedFilter,
        supportsLimit,
      })
    }
  }

  return endpoints
}

/**
 * Scan the spec for nested list endpoints (paths with `{param}` segments that
 * return a Stripe list object) and map each to its parent resource.
 */
export function discoverNestedEndpoints(
  spec: OpenApiSpec,
  topLevelEndpoints: Map<string, ListEndpoint>,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): NestedEndpoint[] {
  const nested: NestedEndpoint[] = []
  const paths = spec.paths
  if (!paths) return nested

  const topLevelByPath = new Map<string, ListEndpoint>()
  for (const endpoint of topLevelEndpoints.values()) {
    topLevelByPath.set(endpoint.apiPath, endpoint)
  }

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    if (!isListResponseSchema(responseSchema)) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const paramMatch = apiPath.match(/\{([^}]+)\}/)
    if (!paramMatch) continue
    const parentParamName = paramMatch[1]

    const parentPath = apiPath.slice(0, apiPath.indexOf('/{'))
    const parentEndpoint = topLevelByPath.get(parentPath)
    if (!parentEndpoint) continue

    const params = getOp.parameters ?? []
    const supportsPagination = params.some((p: { name?: string }) => p.name === 'limit')

    nested.push({
      tableName: resolveTableName(resourceId, aliases),
      resourceId,
      apiPath,
      parentTableName: parentEndpoint.tableName,
      parentParamName,
      supportsPagination,
    })
  }

  return nested
}

export function isV2Path(apiPath: string): boolean {
  return apiPath.startsWith('/v2/')
}

// ---------------------------------------------------------------------------
// HTTP-based list / retrieve builders (no Stripe SDK dependency)
// ---------------------------------------------------------------------------

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/**
 * Build a callable list function that hits the Stripe HTTP API directly.
 * Supports both v1 (has_more pagination) and v2 (next_page_url pagination).
 */
export function buildListFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion?: string,
  baseUrl?: string
): ListFn {
  const base = baseUrl ?? DEFAULT_STRIPE_API_BASE

  if (isV2Path(apiPath)) {
    return async (params) => {
      const qs = new URLSearchParams()
      qs.set('limit', String(Math.min(params.limit ?? 20, 20)))
      if (params.starting_after) qs.set('page', params.starting_after)

      const headers = authHeaders(apiKey)
      if (apiVersion) headers['Stripe-Version'] = apiVersion

      const response = await fetch(`${base}${apiPath}?${qs}`, { headers })
      const body = (await response.json()) as {
        data: unknown[]
        next_page_url?: string | null
      }
      const pageCursor = extractPageToken(body.next_page_url)
      return { data: body.data ?? [], has_more: !!body.next_page_url, pageCursor }
    }
  }

  return async (params) => {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.starting_after) qs.set('starting_after', params.starting_after)
    if (params.ending_before) qs.set('ending_before', params.ending_before)
    if (params.created) {
      for (const [op, val] of Object.entries(params.created)) {
        if (val != null) qs.set(`created[${op}]`, String(val))
      }
    }

    const response = await fetch(`${base}${apiPath}?${qs}`, {
      headers: authHeaders(apiKey),
    })
    const body = (await response.json()) as { data: unknown[]; has_more: boolean }
    return { data: body.data ?? [], has_more: body.has_more }
  }
}

/**
 * Build a callable retrieve function that hits the Stripe HTTP API directly.
 */
export function buildRetrieveFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion?: string,
  baseUrl?: string
): RetrieveFn {
  const base = baseUrl ?? DEFAULT_STRIPE_API_BASE

  if (isV2Path(apiPath)) {
    return async (id) => {
      const headers = authHeaders(apiKey)
      if (apiVersion) headers['Stripe-Version'] = apiVersion

      const response = await fetch(`${base}${apiPath}/${id}`, { headers })
      return await response.json()
    }
  }

  return async (id) => {
    const response = await fetch(`${base}${apiPath}/${id}`, {
      headers: authHeaders(apiKey),
    })
    return await response.json()
  }
}

function extractPageToken(nextPageUrl: string | null | undefined): string | undefined {
  if (!nextPageUrl) return undefined
  try {
    const url = new URL(nextPageUrl, DEFAULT_STRIPE_API_BASE)
    return url.searchParams.get('page') ?? undefined
  } catch {
    return undefined
  }
}
