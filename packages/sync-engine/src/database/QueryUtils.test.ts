import { describe, it, expect } from 'vitest'
import { QueryUtils, type InsertColumn } from './QueryUtils'

describe('QueryUtils', () => {
  describe('quoteIdent', () => {
    it.each([
      ['simple', '"simple"'],
      ['my_table', '"my_table"'],
      ['CamelCase', '"CamelCase"'],
      ['_raw_data', '"_raw_data"'],
    ])('QueryUtils.quoteIdent(%s) => %s', (input, expected) => {
      expect(QueryUtils.quoteIdent(input)).toBe(expected)
    })
  })

  describe('quotedList', () => {
    it.each([
      [['id'], '"id"'],
      [['a', 'b'], '"a", "b"'],
      [
        ['_account_id', 'event_timestamp', 'event_type'],
        '"_account_id", "event_timestamp", "event_type"',
      ],
    ])('QueryUtils.quotedList(%j) => %s', (input, expected) => {
      expect(QueryUtils.quotedList(input)).toBe(expected)
    })

    it('returns empty string for empty array', () => {
      expect(QueryUtils.quotedList([])).toBe('')
    })
  })

  describe('buildInsertParts', () => {
    it.each<[string, InsertColumn[], { columnsSql: string; valuesSql: string }]>([
      [
        'single column',
        [{ column: 'id', pgType: 'text', value: 'abc' }],
        { columnsSql: '"id"', valuesSql: '$1::text' },
      ],
      [
        'multiple columns',
        [
          { column: '_raw_data', pgType: 'jsonb', value: '{}' },
          { column: 'name', pgType: 'text', value: 'test' },
        ],
        { columnsSql: '"_raw_data", "name"', valuesSql: '$1::jsonb, $2::text' },
      ],
      [
        'typical upsert columns',
        [
          { column: '_raw_data', pgType: 'jsonb', value: '{"id":"x"}' },
          { column: '_last_synced_at', pgType: 'timestamptz', value: '2025-01-01T00:00:00Z' },
          { column: '_account_id', pgType: 'text', value: 'acct_123' },
        ],
        {
          columnsSql: '"_raw_data", "_last_synced_at", "_account_id"',
          valuesSql: '$1::jsonb, $2::timestamptz, $3::text',
        },
      ],
    ])('%s', (_name, columns, expected) => {
      const result = QueryUtils.buildInsertParts(columns)
      expect(result.columnsSql).toBe(expected.columnsSql)
      expect(result.valuesSql).toBe(expected.valuesSql)
    })

    it('extracts params in order', () => {
      const columns: InsertColumn[] = [
        { column: 'a', pgType: 'text', value: 'val_a' },
        { column: 'b', pgType: 'int', value: 42 },
        { column: 'c', pgType: 'jsonb', value: { nested: true } },
      ]
      const result = QueryUtils.buildInsertParts(columns)
      expect(result.params).toEqual(['val_a', 42, { nested: true }])
    })
  })

  describe('buildRawJsonUpsertQuery', () => {
    const baseColumns: InsertColumn[] = [
      { column: '_raw_data', pgType: 'jsonb', value: '{"id":"obj_1"}' },
      { column: '_last_synced_at', pgType: 'timestamptz', value: '2025-01-01T00:00:00Z' },
      { column: '_account_id', pgType: 'text', value: 'acct_123' },
    ]

    it.each([
      ['id'],
      ['_account_id', 'event_timestamp'],
      ['_account_id', 'event_timestamp', 'event_type', 'subscription_item_id'],
    ])('builds valid SQL with conflict target: %j', (...conflictTarget) => {
      const { sql, params } = QueryUtils.buildRawJsonUpsertQuery(
        'stripe',
        'test_table',
        baseColumns,
        conflictTarget
      )

      expect(sql).toContain('INSERT INTO "stripe"."test_table"')
      expect(sql).toContain(`ON CONFLICT (${QueryUtils.quotedList(conflictTarget)})`)
      expect(sql).toContain('DO UPDATE SET')
      expect(sql).toContain('"_raw_data" = EXCLUDED."_raw_data"')
      expect(sql).toContain('"_last_synced_at" = $2')
      expect(sql).toContain('RETURNING *')
      expect(params).toHaveLength(3)
    })

    it('includes extra columns in insert', () => {
      const columns: InsertColumn[] = [
        { column: '_raw_data', pgType: 'jsonb', value: '{}' },
        { column: 'event_timestamp', pgType: 'timestamptz', value: '2025-06-01T12:00:00Z' },
        { column: 'event_type', pgType: 'text', value: 'subscription_created' },
        { column: '_last_synced_at', pgType: 'timestamptz', value: '2025-01-01T00:00:00Z' },
        { column: '_account_id', pgType: 'text', value: 'acct_123' },
      ]

      const { sql, params } = QueryUtils.buildRawJsonUpsertQuery(
        'stripe',
        'subscription_item_change_events_v2_beta',
        columns,
        ['_account_id', 'event_timestamp', 'event_type']
      )

      expect(sql).toContain(
        '"_raw_data", "event_timestamp", "event_type", "_last_synced_at", "_account_id"'
      )
      expect(sql).toContain('$1::jsonb, $2::timestamptz, $3::text, $4::timestamptz, $5::text')
      expect(params).toEqual([
        '{}',
        '2025-06-01T12:00:00Z',
        'subscription_created',
        '2025-01-01T00:00:00Z',
        'acct_123',
      ])
    })

    it('throws if _last_synced_at column is missing', () => {
      const columnsWithoutTimestamp: InsertColumn[] = [
        { column: '_raw_data', pgType: 'jsonb', value: '{}' },
        { column: '_account_id', pgType: 'text', value: 'acct_123' },
      ]

      expect(() =>
        QueryUtils.buildRawJsonUpsertQuery('stripe', 'test', columnsWithoutTimestamp, ['id'])
      ).toThrow('buildRawJsonUpsertQuery requires _last_synced_at column')
    })

    it('uses correct param index for timestamp protection WHERE clause', () => {
      // _last_synced_at is at index 1 (0-based), so $2 in SQL
      const { sql } = QueryUtils.buildRawJsonUpsertQuery('stripe', 'customers', baseColumns, ['id'])

      // The WHERE clause should reference the _last_synced_at param
      expect(sql).toContain('"customers"."_last_synced_at" IS NULL')
      expect(sql).toContain('"customers"."_last_synced_at" < $2')
    })
  })
})
