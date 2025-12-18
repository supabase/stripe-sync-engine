import { describe, it, expect, test } from 'vitest'
import {
  buildSigmaCursorWhereClause,
  buildSigmaQuery,
  encodeSigmaCursor,
  type SigmaIngestionConfig,
  type SigmaCursorSpec,
} from './sigmaIngestion'

describe('sigmaIngestion helpers', () => {
  const cfg: SigmaIngestionConfig = {
    sigmaTable: 'subscription_item_change_events_v2_beta',
    destinationTable: 'subscription_item_change_events_v2_beta',
    pageSize: 100,
    cursor: {
      version: 1,
      columns: [
        { column: 'event_timestamp', type: 'timestamp' },
        { column: 'event_type', type: 'string' },
        { column: 'subscription_item_id', type: 'string' },
      ],
    },
    upsert: { conflictTarget: ['id'] },
  }

  describe('buildSigmaCursorWhereClause', () => {
    const singleColCursor: SigmaCursorSpec = {
      version: 1,
      columns: [{ column: 'id', type: 'string' }],
    }

    const doubleColCursor: SigmaCursorSpec = {
      version: 1,
      columns: [
        { column: 'ts', type: 'timestamp' },
        { column: 'id', type: 'string' },
      ],
    }

    test.each([
      {
        name: 'Single column',
        spec: singleColCursor,
        values: ['abc'],
        expected: "(id > 'abc')",
      },
      {
        name: 'Two columns',
        spec: doubleColCursor,
        values: ['2024-01-01T00:00:00Z', 'xyz'],
        // (ts > T) OR (ts = T AND id > 'xyz')
        expected:
          "(ts > timestamp '2024-01-01 00:00:00.000') OR (ts = timestamp '2024-01-01 00:00:00.000' AND id > 'xyz')",
      },
      {
        name: 'Three columns (Standard)',
        spec: cfg.cursor,
        values: ['2024-01-01T00:00:00Z', 'type_a', 'si_123'],
        // 1. (ts > T)
        // 2. (ts = T AND type > 'type_a')
        // 3. (ts = T AND type = 'type_a' AND id > 'si_123')
        expected:
          "(event_timestamp > timestamp '2024-01-01 00:00:00.000') OR " +
          "(event_timestamp = timestamp '2024-01-01 00:00:00.000' AND event_type > 'type_a') OR " +
          "(event_timestamp = timestamp '2024-01-01 00:00:00.000' AND event_type = 'type_a' AND subscription_item_id > 'si_123')",
      },
      {
        name: 'Escaping quotes',
        spec: singleColCursor,
        values: ["user's"],
        expected: "(id > 'user''s')",
      },
    ])('$name', ({ spec, values, expected }) => {
      const sql = buildSigmaCursorWhereClause(spec, values)
      expect(sql).toBe(expected)
    })
  })

  it('encodes composite cursors in a lexicographically sortable way for prefix strings', () => {
    const baseTs = '2025-04-01T12:34:56.789Z'
    const c1 = encodeSigmaCursor(cfg.cursor, [baseTs, 'a', 'si_1'])
    const c2 = encodeSigmaCursor(cfg.cursor, [baseTs, 'aa', 'si_1'])

    // If delimiter sorts after letters, this would be wrong (a < aa). We want c1 < c2.
    expect(c1 < c2).toBe(true)
  })

  it('builds a Sigma query with composite cursor predicate and escaping', () => {
    const cursor = encodeSigmaCursor(cfg.cursor, ['2025-04-01T12:34:56.789Z', "a'b", 'si_1'])
    const sql = buildSigmaQuery(cfg, cursor)

    expect(sql).toContain('SELECT * FROM subscription_item_change_events_v2_beta')
    expect(sql).toContain('ORDER BY event_timestamp, event_type, subscription_item_id ASC')

    // Ensure quotes are escaped: a'b -> a''b
    expect(sql).toContain("event_type > 'a''b'")
  })
})
