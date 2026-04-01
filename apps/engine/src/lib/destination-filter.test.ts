import { describe, expect, it } from 'vitest'
import type { ConfiguredCatalog } from '@stripe/sync-protocol'
import { applySelection } from './destination-filter.js'

function makeCatalog(
  streams: Array<{
    name: string
    fields?: string[]
    json_schema?: Record<string, unknown>
  }>
): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: [['id']], json_schema: s.json_schema },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'append' as const,
      fields: s.fields,
    })),
  }
}

function props(catalog: ConfiguredCatalog, index = 0): Record<string, unknown> {
  return catalog.streams[index]!.stream.json_schema!.properties as Record<string, unknown>
}

describe('applySelection()', () => {
  it('prunes json_schema.properties to selected fields plus primary key', () => {
    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['name', 'email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
    ])

    const filtered = applySelection(catalog)
    expect(Object.keys(props(filtered))).toEqual(['id', 'name', 'email'])
  })

  it('passes catalog through unchanged when no fields configured', () => {
    const catalog = makeCatalog([
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            active: { type: 'boolean' },
          },
        },
      },
    ])

    const filtered = applySelection(catalog)
    expect(Object.keys(props(filtered))).toEqual(['id', 'name', 'active'])
  })

  it('passes stream through unchanged when json_schema is absent', () => {
    const catalog = makeCatalog([{ name: 'events', fields: ['id', 'type'] }])
    const filtered = applySelection(catalog)
    expect(filtered.streams[0]!.stream.json_schema).toBeUndefined()
  })

  it('filters only streams that have fields set', () => {
    const catalog = makeCatalog([
      {
        name: 'customers',
        fields: ['email'],
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
        },
      },
      {
        name: 'products',
        json_schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    ])

    const filtered = applySelection(catalog)
    expect(Object.keys(props(filtered, 0))).toEqual(['id', 'email'])
    expect(Object.keys(props(filtered, 1))).toEqual(['id', 'name'])
  })
})
