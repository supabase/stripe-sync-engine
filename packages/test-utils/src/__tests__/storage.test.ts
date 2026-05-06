import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ensureObjectTable } from '../db/storage.js'

describe('ensureObjectTable', () => {
  it('creates the pagination index used by the fake Stripe server', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const pool = { query } as unknown as pg.Pool

    await ensureObjectTable(pool, 'stripe', 'customers')

    expect(query).toHaveBeenCalledTimes(2)
    expect(normalizeSql(query.mock.calls[1]?.[0] as string)).toBe(
      'CREATE INDEX IF NOT EXISTS "customers_created_id_idx" ON "stripe"."customers" ("created" DESC, "id" DESC)'
    )
  })
})

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}
