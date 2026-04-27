import { describe, it, expect } from 'vitest'
import { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from '@stripe/sync-openapi'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromOpenApi } from './catalog.js'
import { resolveOpenApiSpec, BUNDLED_API_VERSION } from '@stripe/sync-openapi'

/**
 * Snapshot the list of streams produced by discover() with and without
 * the webhook filter. Catches unintentional changes to what we sync.
 */
describe('catalogFromOpenApi stream list', () => {
  const resolved = resolveOpenApiSpec({ apiVersion: BUNDLED_API_VERSION }, fetch)
  const parser = new SpecParser()

  it('default: only tables with webhook events', async () => {
    const { spec, apiVersion } = await resolved
    const parsed = parser.parse(spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
    })
    const allowedTables = new Set(parsed.tables.map((t) => t.tableName))
    const registry = buildResourceRegistry(
      spec,
      'sk_test_fake',
      apiVersion,
      undefined,
      allowedTables
    )
    const catalog = catalogFromOpenApi(parsed.tables, registry)
    const names = catalog.streams.map((s) => s.name).sort()

    expect(names).toMatchSnapshot()
  })

  it('all listable tables (no webhook filter)', async () => {
    const { spec, apiVersion } = await resolved
    const registry = buildResourceRegistry(spec, 'sk_test_fake', apiVersion)
    const parsed = parser.parse(spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      allowedTables: Object.values(registry).map((r) => r.tableName),
    })
    const catalog = catalogFromOpenApi(parsed.tables, registry)
    const names = catalog.streams.map((s) => s.name).sort()

    expect(names).toMatchSnapshot()
  })
})
