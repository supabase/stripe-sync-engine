import type { OpenApiSchemaObject, OpenApiSchemaOrReference, OpenApiSpec } from './types.js'

const SCHEMA_REF_PREFIX = '#/components/schemas/'
const MAX_DEPTH = 1

type GenContext = {
  spec: OpenApiSpec
  timestamp: number
}

const ID_PREFIXES: Record<string, string> = {
  account: 'acct',
  apple_pay_domain: 'apftw',
  application_fee: 'fee',
  balance_transaction: 'txn',
  'billing.alert': 'alrt',
  'billing.credit_balance_transaction': 'cbtxn',
  'billing.credit_grant': 'credgr',
  'billing.meter': 'mtr',
  'billing_portal.configuration': 'bpc',
  charge: 'ch',
  'checkout.session': 'cs',
  'climate.order': 'climorder',
  'climate.product': 'climsku',
  'climate.supplier': 'climsup',
  country_spec: 'cspec',
  coupon: 'cpn',
  credit_note: 'cn',
  customer: 'cus',
  dispute: 'dp',
  event: 'evt',
  exchange_rate: 'xr',
  file_link: 'link',
  file: 'file',
  invoiceitem: 'ii',
  invoice: 'in',
  payment_intent: 'pi',
  payment_link: 'plink',
  payment_method: 'pm',
  payout: 'po',
  plan: 'plan',
  price: 'price',
  product: 'prod',
  promotion_code: 'promo',
  quote: 'qt',
  refund: 're',
  setup_intent: 'seti',
  subscription: 'sub',
  subscription_schedule: 'sub_sched',
  tax_id: 'txi',
  tax_rate: 'txr',
  topup: 'tu',
  transfer: 'tr',
  webhook_endpoint: 'we',
  v2_core_account: 'acct',
  'v2.core.event_destination': 'ed',
  'v2.core.event': 'evt',
}

export type GenerateObjectsOptions = {
  tableName?: string
  /** Unix timestamp (seconds) used for `created`, `updated`, and `*_at` integer fields. Defaults to now. */
  createdTimestamp?: number
}

/**
 * Generate `count` objects conforming to a named schema in the OpenAPI spec.
 * Resolves `$ref`, `oneOf`/`anyOf`/`allOf`, enums, and nested structures,
 * filling each field with a type-appropriate value.
 */
export function generateObjectsFromSchema(
  spec: OpenApiSpec,
  schemaName: string,
  count: number,
  options?: GenerateObjectsOptions
): Record<string, unknown>[] {
  const schemaOrRef = spec.components?.schemas?.[schemaName]
  if (!schemaOrRef) {
    throw new Error(`Schema "${schemaName}" not found in spec`)
  }

  const schema = resolveRef(schemaOrRef, spec)
  const resourceId = schema['x-resourceId'] ?? schemaName
  const prefix = resolveIdPrefix(resourceId, options?.tableName)
  const ctx: GenContext = {
    spec,
    timestamp: options?.createdTimestamp ?? Math.floor(Date.now() / 1000),
  }

  const template = generateObject(schema, ctx, 0) as Record<string, unknown>
  if (schema.properties?.object) {
    template.object = resourceId
  }

  const objects: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    objects.push({ ...template, id: `${prefix}_${i.toString(36).padStart(12, '0')}` })
  }

  return objects
}

/**
 * Find the component schema name for a given `x-resourceId`.
 * Returns `undefined` if no matching schema exists.
 */
export function findSchemaNameByResourceId(
  spec: OpenApiSpec,
  resourceId: string
): string | undefined {
  const schemas = spec.components?.schemas
  if (!schemas) return undefined

  for (const [name, schemaOrRef] of Object.entries(schemas)) {
    if ('$ref' in schemaOrRef) continue
    if (schemaOrRef['x-resourceId'] === resourceId) return name
  }
  return undefined
}

function resolveIdPrefix(resourceId: string, tableName?: string): string {
  if (tableName) {
    const byTable = ID_PREFIXES[tableName]
    if (byTable) return byTable
  }
  return ID_PREFIXES[resourceId] ?? resourceId.replace(/\./g, '_').slice(0, 6)
}

function resolveRef(
  schemaOrRef: OpenApiSchemaOrReference,
  spec: OpenApiSpec,
  seen = new Set<string>()
): OpenApiSchemaObject {
  if (!('$ref' in schemaOrRef)) return schemaOrRef
  const ref = schemaOrRef.$ref
  if (!ref.startsWith(SCHEMA_REF_PREFIX) || seen.has(ref)) return {}
  seen.add(ref)
  const name = ref.slice(SCHEMA_REF_PREFIX.length)
  const resolved = spec.components?.schemas?.[name]
  if (!resolved) return {}
  return resolveRef(resolved, spec, seen)
}

function generateObject(schema: OpenApiSchemaObject, ctx: GenContext, depth: number): unknown {
  const merged = mergeComposed(schema, ctx.spec, depth)
  const properties = merged.properties ?? schema.properties
  if (!properties) return {}

  const obj: Record<string, unknown> = {}
  for (const [key, propRef] of Object.entries(properties)) {
    obj[key] = generateValue(propRef, ctx, key, depth)
  }
  return obj
}

function mergeComposed(
  schema: OpenApiSchemaObject,
  spec: OpenApiSpec,
  depth: number
): OpenApiSchemaObject {
  const composites = schema.allOf ?? schema.anyOf
  if (!composites?.length) return schema

  const mergedProps: Record<string, OpenApiSchemaOrReference> = {
    ...(schema.properties ?? {}),
  }
  for (const sub of composites) {
    const resolved = resolveRef(sub, spec)
    if (resolved.properties) {
      Object.assign(mergedProps, resolved.properties)
    }
    if (resolved.allOf || resolved.anyOf) {
      const nested = mergeComposed(resolved, spec, depth)
      if (nested.properties) {
        Object.assign(mergedProps, nested.properties)
      }
    }
  }
  return { ...schema, properties: mergedProps }
}

function generateValue(
  schemaOrRef: OpenApiSchemaOrReference,
  ctx: GenContext,
  fieldName: string,
  depth: number
): unknown {
  const schema = resolveRef(schemaOrRef, ctx.spec)

  if (schema.nullable) {
    return null
  }

  if (schema.oneOf?.length) {
    return pickFromOneOf(schema.oneOf, ctx, fieldName, depth)
  }
  if (schema.anyOf?.length) {
    return pickFromOneOf(schema.anyOf, ctx, fieldName, depth)
  }
  if (schema.allOf?.length) {
    const merged = mergeComposed(schema, ctx.spec, depth)
    return generateObject(merged, ctx, depth)
  }

  if (schema.enum?.length) {
    return schema.enum[0]
  }

  switch (schema.type) {
    case 'string':
      return generateString(schema, fieldName)
    case 'integer':
      return generateInteger(fieldName, ctx.timestamp)
    case 'number':
      return 0.0
    case 'boolean':
      return false
    case 'array':
      return generateArray(schema, ctx, fieldName, depth)
    case 'object':
      if (depth >= MAX_DEPTH) return {}
      return generateObject(schema, ctx, depth + 1)
  }

  if (schema.properties) {
    if (depth >= MAX_DEPTH) return {}
    return generateObject(schema, ctx, depth + 1)
  }

  return null
}

function pickFromOneOf(
  variants: OpenApiSchemaOrReference[],
  ctx: GenContext,
  fieldName: string,
  depth: number
): unknown {
  for (const variant of variants) {
    const resolved = resolveRef(variant, ctx.spec)
    if (resolved.type === 'string') return generateString(resolved, fieldName)
    if (resolved.type === 'integer') return generateInteger(fieldName, ctx.timestamp)
    if (resolved.type === 'number') return 0.0
    if (resolved.type === 'boolean') return false
    if (resolved.enum?.length) return resolved.enum[0]
  }
  if (depth >= MAX_DEPTH) return null
  const first = resolveRef(variants[0], ctx.spec)
  if (first.properties || first.allOf || first.anyOf) {
    return generateObject(first, ctx, depth + 1)
  }
  return null
}

function generateString(schema: OpenApiSchemaObject, fieldName: string): string {
  if (schema.enum?.length) return String(schema.enum[0])
  if (schema.format === 'date-time') return new Date().toISOString()
  if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com'
  if (fieldName === 'currency') return 'usd'
  if (fieldName === 'email') return 'test@example.com'
  if (fieldName === 'phone') return '+15555555555'
  if (fieldName === 'url' || fieldName.endsWith('_url')) return 'https://example.com'
  return `test_${fieldName}`
}

function generateInteger(fieldName: string, timestamp: number): number {
  if (fieldName === 'created' || fieldName === 'updated') {
    return timestamp
  }
  if (fieldName.endsWith('_at')) {
    return timestamp
  }
  return 0
}

function generateArray(
  schema: OpenApiSchemaObject,
  ctx: GenContext,
  _fieldName: string,
  depth: number
): unknown[] {
  if (!schema.items || depth >= MAX_DEPTH) return []
  const itemSchema = resolveRef(schema.items, ctx.spec)
  if (itemSchema.properties || itemSchema.allOf || itemSchema.anyOf) {
    if (depth + 1 >= MAX_DEPTH) return []
    return [generateObject(itemSchema, ctx, depth + 1)]
  }
  if (itemSchema.type === 'string') return ['test_item']
  if (itemSchema.type === 'integer') return [0]
  return []
}
