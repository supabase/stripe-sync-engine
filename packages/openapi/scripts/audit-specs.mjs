#!/usr/bin/env node
/**
 * Audit which Stripe OpenAPI resources are filtered out by the two discovery filters.
 *
 * Prints two lists:
 *   1. Resources with an x-resourceId but no LIST endpoint
 *      (would be filtered by discoverListableResourceIds)
 *   2. Resources with an x-resourceId but no CREATE/UPDATE/DELETE webhook event
 *      (would be filtered by discoverWebhookUpdatableResourceIds)
 *
 * A resource filtered by both checks appears in both lists.
 *
 * Usage:
 *   node packages/openapi/scripts/audit-specs.mjs [path/to/spec.json]
 *
 * Defaults to the bundled spec in packages/openapi/oas/ when no path is given.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const specPath =
  process.argv[2] ??
  (() => {
    const oasDir = join(__dirname, '..', 'oas')
    const files = readdirSync(oasDir).filter(
      (f) => f.endsWith('.json') && f !== 'manifest.json' && f !== 'index.html'
    )
    if (!files.length) {
      console.error('No bundled spec found in packages/openapi/oas/. Run pnpm build first.')
      process.exit(1)
    }
    return join(oasDir, files[0])
  })()

const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const schemas = spec.components?.schemas ?? {}
const paths = spec.paths ?? {}

// ── 1. All resource IDs ──────────────────────────────────────────────────────
const allResourceIds = new Set()
for (const schema of Object.values(schemas)) {
  if (schema && typeof schema === 'object' && !('$ref' in schema)) {
    const resourceId = schema['x-resourceId']
    if (resourceId && typeof resourceId === 'string') {
      allResourceIds.add(resourceId)
    }
  }
}

// ── 2. Listable resource IDs ─────────────────────────────────────────────────
// Mirrors discoverListableResourceIds(spec, { includeNested: true })
const SCHEMA_REF_PREFIX = '#/components/schemas/'

function isListResponseSchema(schema) {
  const dataProp = schema.properties?.data
  if (!dataProp || dataProp.type !== 'array') return false
  const objectProp = schema.properties?.object
  if (objectProp && Array.isArray(objectProp.enum) && objectProp.enum.includes('list')) return true
  if (schema.properties?.next_page_url) return true
  return false
}

const listableIds = new Set()
for (const [, pathItem] of Object.entries(paths)) {
  const getOp = pathItem.get
  if (!getOp?.responses) continue
  const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
  if (!responseSchema || !isListResponseSchema(responseSchema)) continue
  const dataProp = responseSchema.properties?.data
  if (!dataProp || dataProp.type !== 'array') continue
  const itemsRef = dataProp.items
  if (!itemsRef || typeof itemsRef.$ref !== 'string') continue
  if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue
  const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
  const schema = schemas[schemaName]
  if (!schema || '$ref' in schema) continue
  const resourceId = schema['x-resourceId']
  if (resourceId && typeof resourceId === 'string') {
    listableIds.add(resourceId)
  }
}

// ── 3. Webhook-updatable resource IDs ────────────────────────────────────────
// Mirrors discoverWebhookUpdatableResourceIds(spec)
const CRUD_SUFFIXES = ['.created', '.updated', '.deleted']

const webhookIds = new Set()
for (const schema of Object.values(schemas)) {
  if (!schema || typeof schema !== 'object' || '$ref' in schema) continue
  const stripeEvent = schema['x-stripeEvent']
  if (!stripeEvent || typeof stripeEvent !== 'object') continue
  const eventType = stripeEvent.type
  if (!eventType || !CRUD_SUFFIXES.some((s) => eventType.endsWith(s))) continue
  const objectProp = schema.properties?.object
  if (!objectProp || typeof objectProp.$ref !== 'string') continue
  if (!objectProp.$ref.startsWith(SCHEMA_REF_PREFIX)) continue
  const schemaName = objectProp.$ref.slice(SCHEMA_REF_PREFIX.length)
  const refSchema = schemas[schemaName]
  if (!refSchema || '$ref' in refSchema) continue
  const resourceId = refSchema['x-resourceId']
  if (resourceId && typeof resourceId === 'string') {
    webhookIds.add(resourceId)
  }
}

// ── 4. Print audit results ────────────────────────────────────────────────────
const specVersion = spec.info?.version ?? spec.openapi ?? 'unknown'
console.log(`Stripe OpenAPI spec: ${specPath}`)
console.log(`API version: ${specVersion}`)
console.log(`Total resources with x-resourceId: ${allResourceIds.size}`)
console.log()

const noList = [...allResourceIds].filter((id) => !listableIds.has(id)).sort()
console.log(`── Filtered out: no LIST endpoint (${noList.length}) ──────────────────────────────`)
for (const id of noList) {
  console.log(`  ${id}`)
}

console.log()

const noWebhook = [...allResourceIds].filter((id) => !webhookIds.has(id)).sort()
console.log(
  `── Filtered out: no CREATE/UPDATE/DELETE webhook events (${noWebhook.length}) ──────────────────────────────`
)
for (const id of noWebhook) {
  console.log(`  ${id}`)
}

console.log()

// Resources that passed the old filter (list only) but are now dropped by the webhook filter
const newlyExcluded = [...listableIds].filter((id) => !webhookIds.has(id)).sort()
console.log(
  `── Newly excluded by webhook filter (had LIST, no webhook events) (${newlyExcluded.length}) ──────────────────────────────`
)
for (const id of newlyExcluded) {
  console.log(`  ${id}`)
}

console.log()
const passedBoth = [...allResourceIds].filter(
  (id) => listableIds.has(id) && webhookIds.has(id)
).sort()
console.log(`── Passes both filters (${passedBoth.length}) ──────────────────────────────`)
for (const id of passedBoth) {
  console.log(`  ${id}`)
}
