import type { OpenAPIOperation, OpenAPIParameter, OpenAPISchema, OpenAPISpec } from './types.js'

export interface ParsedOperation {
  method: string
  path: string
  operationId?: string
  tags: string[]
  pathParams: OpenAPIParameter[]
  queryParams: OpenAPIParameter[]
  headerParams: OpenAPIParameter[]
  bodySchema?: OpenAPISchema
  bodyRequired?: boolean
  ndjsonResponse: boolean
  ndjsonRequest: boolean
  noContent: boolean
}

/** Extract all operations from an OpenAPI spec into a flat list. */
export function parseSpec(spec: OpenAPISpec): ParsedOperation[] {
  const operations: ParsedOperation[] = []

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = rawMethod.toLowerCase()
      // Skip non-method keys (parameters, summary, etc.)
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)) {
        continue
      }

      const params = operation.parameters ?? []
      const pathParams = params.filter((p: OpenAPIParameter) => p.in === 'path')
      const queryParams = params.filter((p: OpenAPIParameter) => p.in === 'query')
      const headerParams = params.filter((p: OpenAPIParameter) => p.in === 'header')

      // Extract body schema from application/json or application/x-ndjson
      const content = operation.requestBody?.content ?? {}
      const jsonContent = content['application/json']
      const ndjsonContent = content['application/x-ndjson']
      const bodySchema = jsonContent?.schema ?? ndjsonContent?.schema
      const ndjsonRequest = !!ndjsonContent && !jsonContent

      operations.push({
        method,
        path,
        operationId: operation.operationId,
        tags: operation.tags ?? [],
        pathParams,
        queryParams,
        headerParams,
        bodySchema,
        bodyRequired: operation.requestBody?.required,
        ndjsonResponse: isNdjsonResponse(operation),
        ndjsonRequest,
        noContent: isNoContent(operation),
      })
    }
  }

  return operations
}

/** Convert camelCase or snake_case to kebab-case. */
export function toCliFlag(name: string): string {
  return name
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
}

/** Check if the operation's response is NDJSON. */
export function isNdjsonResponse(operation: OpenAPIOperation): boolean {
  const responses = operation.responses ?? {}
  for (const response of Object.values(responses)) {
    if (response.content?.['application/x-ndjson']) return true
  }
  return false
}

/** Check if the operation returns 204 No Content. */
function isNoContent(operation: OpenAPIOperation): boolean {
  return !!operation.responses?.['204']
}

/** Derive a CLI command name from operationId or method+path. */
export function defaultOperationName(
  method: string,
  path: string,
  operation: OpenAPIOperation
): string {
  if (operation.operationId) {
    // Convert operationId to kebab-case: listSyncs → list-syncs
    return toCliFlag(operation.operationId)
  }
  // Strip path params and slashes: POST /syncs/{id}/run → post-syncs-run
  const cleaned = path
    .replace(/\{[^}]+\}/g, '') // remove path params
    .replace(/\/+/g, '-') // slashes to dashes
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .replace(/-+/g, '-') // collapse multiple dashes
  return `${method}-${cleaned}`
}
