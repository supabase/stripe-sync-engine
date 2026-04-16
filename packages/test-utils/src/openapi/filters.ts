import type { EndpointQueryParam } from './endpoints.js'
import type { OpenApiSchemaObject, OpenApiSchemaOrReference } from '@stripe/sync-openapi'

const NESTED_QUERY_KEY = /^([^\[]+)\[([^\]]+)\]$/

export type ValidatedQuery = {
  ok: true
  forward: URLSearchParams
}

export type QueryValidationError = {
  ok: false
  statusCode: number
  message: string
  details: string[]
  allowed: string[]
}

export function validateQueryAgainstOpenApi(
  input: URLSearchParams,
  params: EndpointQueryParam[]
): ValidatedQuery | QueryValidationError {
  const forward = new URLSearchParams()
  const errors: string[] = []
  const provided = new Set<string>()
  const directAllowed = new Set<string>()
  const objectAllowed = new Map<string, Set<string>>()
  const paramByName = new Map<string, EndpointQueryParam>()

  for (const param of params) {
    paramByName.set(param.name, param)
    directAllowed.add(param.name)
    const objectProps = objectPropertyNames(param.schema)
    if (objectProps.size > 0) {
      objectAllowed.set(param.name, objectProps)
    }
  }

  for (const [key, value] of input.entries()) {
    const direct = paramByName.get(key)
    if (direct) {
      if (!isValidForSchema(value, direct.schema)) {
        errors.push(`Invalid value for query parameter "${key}"`)
        continue
      }
      forward.append(key, value)
      provided.add(key)
      continue
    }

    const nested = key.match(NESTED_QUERY_KEY)
    if (!nested) {
      errors.push(`Unknown query parameter "${key}"`)
      continue
    }

    const [, base, subKey] = nested
    const nestedAllowed = objectAllowed.get(base)
    if (!nestedAllowed || !nestedAllowed.has(subKey)) {
      errors.push(`Unknown nested query parameter "${key}"`)
      continue
    }

    const baseSchema = paramByName.get(base)?.schema
    const objectVariant = findObjectVariant(baseSchema)
    const propertySchema =
      objectVariant && objectVariant.properties
        ? resolvePropertySchema(objectVariant.properties[subKey])
        : undefined
    if (!isValidForSchema(value, propertySchema)) {
      errors.push(`Invalid value for query parameter "${key}"`)
      continue
    }

    forward.append(key, value)
    provided.add(base)
  }

  for (const param of params) {
    if (param.required && !provided.has(param.name)) {
      errors.push(`Missing required query parameter "${param.name}"`)
    }
  }

  const allowed = [...directAllowed].sort()
  for (const [name, props] of objectAllowed.entries()) {
    for (const prop of props) allowed.push(`${name}[${prop}]`)
  }
  allowed.sort()

  if (errors.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      message: 'Query parameters do not match OpenAPI definition',
      details: errors,
      allowed,
    }
  }

  return { ok: true, forward }
}

function objectPropertyNames(schema: OpenApiSchemaObject | undefined): Set<string> {
  if (!schema) return new Set()
  if (schema.type === 'object' && schema.properties) {
    return new Set(Object.keys(schema.properties))
  }
  for (const variant of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    if ('$ref' in variant) continue
    const names = objectPropertyNames(variant)
    if (names.size > 0) return names
  }
  return new Set()
}

function findObjectVariant(
  schema: OpenApiSchemaObject | undefined
): OpenApiSchemaObject | undefined {
  if (!schema) return undefined
  if (schema.type === 'object' && schema.properties) return schema
  for (const variant of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    if ('$ref' in variant) continue
    const found = findObjectVariant(variant)
    if (found) return found
  }
  return undefined
}

function resolvePropertySchema(
  schema: OpenApiSchemaOrReference | undefined
): OpenApiSchemaObject | undefined {
  if (!schema || '$ref' in schema) return undefined
  return schema
}

function isValidForSchema(value: string, schema: OpenApiSchemaObject | undefined): boolean {
  if (!schema) return true

  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.some((entry) => String(entry) === value)
  }

  if (schema.oneOf?.length) {
    return schema.oneOf.some((candidate) =>
      isValidForSchema(value, resolvePropertySchema(candidate))
    )
  }
  if (schema.anyOf?.length) {
    return schema.anyOf.some((candidate) =>
      isValidForSchema(value, resolvePropertySchema(candidate))
    )
  }

  switch (schema.type) {
    case 'integer':
      return /^-?\d+$/.test(value)
    case 'number':
      return Number.isFinite(Number(value))
    case 'boolean':
      return value === 'true' || value === 'false'
    default:
      return true
  }
}
