import type { OpenApiOperationObject, OpenApiPathItem, OpenApiSpec } from './types.js'
import { GLOBALLY_DEPRECATED_PATHS } from './src/deprecatedPaths.js'

const DEPRECATED_DESCRIPTION_RE = /^\s*<p>\s*\[Deprecated\]/i

/**
 * Returns true if the operation is marked as deprecated, either via the
 * standard OpenAPI `deprecated: true` flag or via Stripe's convention of
 * starting the description with `<p>[Deprecated]`.
 */
export function isDeprecatedOperation(op: OpenApiOperationObject): boolean {
  if (op.deprecated === true) return true
  if (op.description && DEPRECATED_DESCRIPTION_RE.test(op.description)) return true
  return false
}

/**
 * Remove deprecated GET operations before discovery/parsing so downstream code
 * can iterate paths without carrying special-case deprecation logic around.
 */
export function cleanOpenApiSpec(spec: OpenApiSpec): OpenApiSpec {
  const paths = spec.paths
  if (!paths) {
    return spec
  }

  let cleanedPaths: Record<string, OpenApiPathItem> | undefined

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    const getOp = pathItem.get
    if (!getOp) {
      continue
    }
    if (!isDeprecatedOperation(getOp) && !GLOBALLY_DEPRECATED_PATHS.has(apiPath)) {
      continue
    }

    if (!cleanedPaths) {
      cleanedPaths = { ...paths }
    }

    const { get: _, ...rest } = pathItem
    if (Object.keys(rest).length === 0) {
      delete cleanedPaths[apiPath]
      continue
    }

    cleanedPaths[apiPath] = rest
  }

  return cleanedPaths
    ? {
        ...spec,
        paths: cleanedPaths,
      }
    : spec
}
