import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfiguredCatalog } from '@stripe/sync-protocol'
import { createPostgresSource } from './index.js'
import spec, { configSchema } from './spec.js'

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iterable) out.push(item)
  return out
}

function queryResult<T extends Record<string, unknown>>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  }
}

describe('source-postgres', () => {
  it('validates config constraints through the JSON Schema path', () => {
    const jsonSchemaConfig = z.fromJSONSchema(spec.config)
    const validTableConfig = {
      url: 'postgres://example',
      table: 'crm_customers',
      cursor_field: 'updated_at',
    }
    const validQueryConfig = {
      url: 'postgres://example',
      query: 'SELECT * FROM crm_customers',
      stream: 'crm_customers',
      cursor_field: 'updated_at',
    }

    expect(jsonSchemaConfig.safeParse(validTableConfig).success).toBe(true)
    expect(jsonSchemaConfig.safeParse(validQueryConfig).success).toBe(true)
    for (const invalidConfig of [
      { table: 'crm_customers', cursor_field: 'updated_at' },
      {
        url: 'postgres://example',
        table: 'crm_customers',
        query: 'SELECT * FROM crm_customers',
        stream: 'crm_customers',
        cursor_field: 'updated_at',
      },
      {
        url: 'postgres://example',
        query: 'SELECT * FROM crm_customers',
        cursor_field: 'updated_at',
      },
    ]) {
      expect(jsonSchemaConfig.safeParse(invalidConfig).success).toBe(false)
      expect(configSchema.safeParse(invalidConfig).success).toBe(false)
    }
  })

  it('discovers a configured table as one stream', async () => {
    const config = configSchema.parse({
      url: 'postgres://example',
      schema: 'public',
      table: 'crm_customers',
      primary_key: ['id'],
      cursor_field: 'updated_at',
    })

    const source = createPostgresSource({
      createPool: () => ({
        async query(text: string) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'email', data_type: 'text', is_nullable: 'YES' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }
          return queryResult([])
        },
        async end() {},
      }),
    })

    const messages = await collect(source.discover({ config }))

    expect(messages).toEqual([
      {
        type: 'catalog',
        catalog: {
          streams: [
            {
              name: 'crm_customers',
              primary_key: [['id']],
              json_schema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  updated_at: { type: 'string' },
                },
                required: ['id', 'updated_at'],
                additionalProperties: true,
              },
              newer_than_field: 'updated_at',
            },
          ],
        },
      },
    ])
  })

  it('discovers pg wire types and nullable values accurately', async () => {
    const config = configSchema.parse({
      url: 'postgres://example',
      table: 'orders',
      primary_key: ['id'],
      cursor_field: 'updated_at',
    })

    const source = createPostgresSource({
      createPool: () => ({
        async query(text: string) {
          if (text.includes('information_schema.columns')) {
            return queryResult([
              { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
              { column_name: 'amount_cents', data_type: 'bigint', is_nullable: 'NO' },
              { column_name: 'ratio', data_type: 'numeric', is_nullable: 'YES' },
              {
                column_name: 'updated_at',
                data_type: 'timestamp with time zone',
                is_nullable: 'NO',
              },
            ])
          }
          return queryResult([])
        },
        async end() {},
      }),
    })

    const messages = await collect(source.discover({ config }))

    expect(messages[0]).toMatchObject({
      type: 'catalog',
      catalog: {
        streams: [
          {
            json_schema: {
              properties: {
                amount_cents: { type: 'string' },
                ratio: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              },
              required: ['id', 'amount_cents', 'updated_at'],
            },
          },
        ],
      },
    })
  })

  it('fails discovery when a configured table has no visible columns', async () => {
    const config = configSchema.parse({
      url: 'postgres://example',
      schema: 'public',
      table: 'missing_table',
      primary_key: ['id'],
      cursor_field: 'updated_at',
    })
    const source = createPostgresSource({
      createPool: () => ({
        async query() {
          return queryResult([])
        },
        async end() {},
      }),
    })

    await expect(collect(source.discover({ config }))).rejects.toThrow(
      'Table "public.missing_table" was not found or has no visible columns'
    )
  })

  it('reads pages and emits source_state after each page', async () => {
    const config = configSchema.parse({
      url: 'postgres://example',
      table: 'crm_customers',
      primary_key: ['id'],
      cursor_field: 'updated_at',
      page_size: 2,
    })
    const rows = [
      { id: 'crm_1', email: 'a@example.com', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 'crm_2', email: 'b@example.com', updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'crm_3', email: 'c@example.com', updated_at: '2026-01-03T00:00:00.000Z' },
    ]
    const catalog: ConfiguredCatalog = {
      streams: [
        {
          stream: {
            name: 'crm_customers',
            primary_key: [['id']],
            newer_than_field: 'updated_at',
          },
          sync_mode: 'incremental',
          destination_sync_mode: 'append',
        },
      ],
    }

    const source = createPostgresSource({
      now: () => new Date('2026-05-03T00:00:00.000Z'),
      createPool: () => ({
        async query(_text: string, values?: unknown[]) {
          const limit = Number(values?.at(-1) ?? 100)
          const cursor = values && values.length > 1 ? String(values[0]) : undefined
          const pk = values && values.length > 1 ? String(values[1]) : undefined
          const page = rows
            .filter(
              (row) =>
                !cursor || row.updated_at > cursor || (row.updated_at === cursor && row.id > pk!)
            )
            .slice(0, limit)
          return queryResult(page)
        },
        async end() {},
      }),
    })

    const messages = await collect(source.read({ config, catalog }))

    expect(messages.map((message) => message.type)).toEqual([
      'record',
      'record',
      'source_state',
      'record',
      'source_state',
    ])
    expect(messages[2]).toMatchObject({
      type: 'source_state',
      source_state: {
        state_type: 'stream',
        stream: 'crm_customers',
        data: { cursor: '2026-01-02T00:00:00.000Z', primary_key: ['crm_2'] },
      },
    })
    expect(messages[4]).toMatchObject({
      type: 'source_state',
      source_state: {
        data: { cursor: '2026-01-03T00:00:00.000Z', primary_key: ['crm_3'] },
      },
    })
  })
})
