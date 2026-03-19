import { describe, expect, it } from 'vitest'
import { catalogFromRegistry } from '../../catalogFromRegistry'
import type { ResourceConfig } from '../../types'

function makeConfig(
  overrides: Partial<ResourceConfig> & { order: number; tableName: string }
): ResourceConfig {
  return {
    supportsCreatedFilter: true,
    listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
    retrieveFn: (() => Promise.resolve({})) as ResourceConfig['retrieveFn'],
    ...overrides,
  } as ResourceConfig
}

describe('catalogFromRegistry', () => {
  it('returns empty streams for empty registry', () => {
    const catalog = catalogFromRegistry({})
    expect(catalog.type).toBe('catalog')
    expect(catalog.streams).toEqual([])
  })

  it('ordering respects the order field', () => {
    const registry: Record<string, ResourceConfig> = {
      invoice: makeConfig({ order: 3, tableName: 'invoices' }),
      customer: makeConfig({ order: 1, tableName: 'customers' }),
      product: makeConfig({ order: 2, tableName: 'products' }),
    }

    const catalog = catalogFromRegistry(registry)
    expect(catalog.streams.map((s) => s.name)).toEqual(['customers', 'products', 'invoices'])
  })

  it('excludes resources with sync: false', () => {
    const registry: Record<string, ResourceConfig> = {
      customer: makeConfig({ order: 1, tableName: 'customers' }),
      internal: makeConfig({ order: 2, tableName: 'internal', sync: false }),
    }

    const catalog = catalogFromRegistry(registry)
    expect(catalog.streams).toHaveLength(1)
    expect(catalog.streams[0].name).toBe('customers')
  })

  it('includes resource_name in metadata', () => {
    const registry: Record<string, ResourceConfig> = {
      customer: makeConfig({ order: 1, tableName: 'customers' }),
    }

    const catalog = catalogFromRegistry(registry)
    expect(catalog.streams[0].metadata).toEqual({ resource_name: 'customer' })
  })

  it('sets primary_key to [["id"]]', () => {
    const registry: Record<string, ResourceConfig> = {
      customer: makeConfig({ order: 1, tableName: 'customers' }),
    }

    const catalog = catalogFromRegistry(registry)
    expect(catalog.streams[0].primary_key).toEqual([['id']])
  })
})
