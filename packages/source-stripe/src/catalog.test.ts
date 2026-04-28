import { describe, it, expect } from 'vitest'
import { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from '@stripe/sync-openapi'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromOpenApi } from './catalog.js'
import { resolveOpenApiSpec, BUNDLED_API_VERSION } from '@stripe/sync-openapi'

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
      allowedTables,
      undefined,
      parsed.tables
    )
    const catalog = catalogFromOpenApi(registry)
    const names = catalog.streams.map((s) => s.name).sort()

    expect(names).toMatchSnapshot()
  })

  it('every stream in the catalog has supports_realtime_sync = true', async () => {
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
      allowedTables,
      undefined,
      parsed.tables
    )
    const catalog = catalogFromOpenApi(registry)
    for (const stream of catalog.streams) {
      expect(stream.metadata?.supports_realtime_sync).toBe(true)
    }
  })

  it('all listable tables (no webhook filter)', async () => {
    const { spec, apiVersion } = await resolved
    const allRegistry = buildResourceRegistry(spec, 'sk_test_fake', apiVersion)
    const parsed = parser.parse(spec, {
      resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      allowedTables: Object.values(allRegistry).map((r) => r.tableName),
    })
    const registry = buildResourceRegistry(
      spec,
      'sk_test_fake',
      apiVersion,
      undefined,
      undefined,
      undefined,
      parsed.tables
    )
    const catalog = catalogFromOpenApi(registry)
    const names = catalog.streams.map((s) => s.name).sort()

    expect(names).toMatchSnapshot()
  })

  it('every stream has json_schema (no ghost tables)', async () => {
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
      allowedTables,
      undefined,
      parsed.tables
    )
    const catalog = catalogFromOpenApi(registry)
    for (const stream of catalog.streams) {
      expect(stream.json_schema, `stream ${stream.name} is missing json_schema`).toBeDefined()
      expect(stream.json_schema?.properties).toBeDefined()
    }
  })

  it('throws when registry entry has no parsedTable', async () => {
    const { spec, apiVersion } = await resolved
    const registry = buildResourceRegistry(spec, 'sk_test_fake', apiVersion)
    expect(() => catalogFromOpenApi(registry)).toThrow(/no parsedTable/)
  })
})
