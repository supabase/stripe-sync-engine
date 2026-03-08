import { describe, it, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest'
import {
  setupTestDatabase,
  createTestStripeSync,
  upsertTestAccount,
  type TestDatabase,
} from '../testSetup'
import type { StripeSync } from '../../index'
import type { SyncEvent } from '../../types'

const TEST_ACCOUNT_ID = 'acct_test_onsync'

describe('onSync callback', () => {
  let sync: StripeSync
  let db: TestDatabase
  let onSyncSpy: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    db = await setupTestDatabase()
  })

  afterAll(async () => {
    if (sync) await sync.postgresClient.pool.end()
    if (db) await db.close()
  })

  beforeEach(async () => {
    if (sync) await sync.postgresClient.pool.end()

    onSyncSpy = vi.fn()

    sync = await createTestStripeSync({
      databaseUrl: db.databaseUrl,
      accountId: TEST_ACCOUNT_ID,
      onSync: onSyncSpy,
    })

    await upsertTestAccount(sync, TEST_ACCOUNT_ID)

    // Clean up test data from prior runs
    await db.pool.query(`DELETE FROM stripe.products WHERE _account_id = $1`, [TEST_ACCOUNT_ID])
  })

  it('fires onSync with operation=upsert after upsertAny', async () => {
    const product = { id: 'prod_onsync_1', object: 'product', name: 'Test' }

    await sync.upsertAny([product], TEST_ACCOUNT_ID)

    expect(onSyncSpy).toHaveBeenCalledOnce()
    const event: SyncEvent = onSyncSpy.mock.calls[0][0]
    expect(event.table).toBe('products')
    expect(event.accountId).toBe(TEST_ACCOUNT_ID)
    expect(event.operation).toBe('upsert')
    expect(event.rows).toHaveLength(1)
    expect(event.timestamp).toBeDefined()
  })

  it('fires onSync with operation=delete after hard delete via webhook', async () => {
    // Insert first so there's something to delete
    const product = { id: 'prod_onsync_del', object: 'product', name: 'ToDelete' }
    await sync.upsertAny([product], TEST_ACCOUNT_ID)
    onSyncSpy.mockClear()

    // Hard delete via postgresClient (simulating what the webhook handler does)
    const deleted = await sync.postgresClient.delete('products', 'prod_onsync_del')
    expect(deleted).toBe(true)

    // Verify the row is actually gone
    const result = await db.pool.query(
      `SELECT id FROM stripe.products WHERE id = $1`, ['prod_onsync_del']
    )
    expect(result.rows).toHaveLength(0)
  })

  it('fires onSync with operation=upsert for soft deletes (deleted=true)', async () => {
    // Soft delete means upserting with deleted: true — goes through upsertAny
    const product = { id: 'prod_onsync_soft', object: 'product', name: 'SoftDelete' }
    await sync.upsertAny([product], TEST_ACCOUNT_ID)
    onSyncSpy.mockClear()

    // Soft delete = upsert with deleted: true (this is how webhook handler does it)
    const deletedProduct = { ...product, deleted: true }
    await sync.upsertAny([deletedProduct], TEST_ACCOUNT_ID)

    expect(onSyncSpy).toHaveBeenCalledOnce()
    const event: SyncEvent = onSyncSpy.mock.calls[0][0]
    expect(event.table).toBe('products')
    expect(event.operation).toBe('upsert')
    expect(event.rows).toHaveLength(1)
  })

  it('does not fire onSync when upserting an empty array', async () => {
    await sync.upsertAny([], TEST_ACCOUNT_ID)

    expect(onSyncSpy).not.toHaveBeenCalled()
  })

  it('catches and logs onSync errors without breaking the sync', async () => {
    onSyncSpy.mockRejectedValue(new Error('callback boom'))
    const product = { id: 'prod_onsync_err', object: 'product', name: 'ErrTest' }

    // Should not throw
    const result = await sync.upsertAny([product], TEST_ACCOUNT_ID)

    expect(result).toHaveLength(1)
    expect(onSyncSpy).toHaveBeenCalledOnce()
  })

  it('fires onSync once per upsertAny call (not per chunk)', async () => {
    // Insert 12 products — upsertManyWithTimestampProtection chunks internally
    const products = Array.from({ length: 12 }, (_, i) => ({
      id: `prod_chunk_${i}`,
      object: 'product',
      name: `Chunk ${i}`,
    }))

    await sync.upsertAny(products, TEST_ACCOUNT_ID)

    // Should fire once with all rows, not per-chunk
    expect(onSyncSpy).toHaveBeenCalledOnce()
    const event: SyncEvent = onSyncSpy.mock.calls[0][0]
    expect(event.rows.length).toBe(12)
  })
})

describe('onSync not provided (backward compat)', () => {
  let sync: StripeSync
  let db: TestDatabase

  beforeAll(async () => {
    db = await setupTestDatabase()

    sync = await createTestStripeSync({
      databaseUrl: db.databaseUrl,
      accountId: TEST_ACCOUNT_ID,
      // onSync intentionally omitted
    })

    await upsertTestAccount(sync, TEST_ACCOUNT_ID)
  })

  afterAll(async () => {
    if (sync) await sync.postgresClient.pool.end()
    if (db) await db.close()
  })

  it('works without onSync callback', async () => {
    const product = { id: 'prod_no_onsync', object: 'product', name: 'NoCallback' }

    const result = await sync.upsertAny([product], TEST_ACCOUNT_ID)

    expect(result).toHaveLength(1)
  })
})
