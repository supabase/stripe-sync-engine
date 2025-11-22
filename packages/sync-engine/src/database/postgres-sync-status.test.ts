import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgresClient } from './postgres'
import pg from 'pg'

describe('Postgres Sync Status Methods', () => {
  let postgresClient: PostgresClient
  let pool: pg.Pool
  const testAccountId = 'acct_test_123'

  beforeAll(async () => {
    const databaseUrl =
      process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'

    postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig: {
        connectionString: databaseUrl,
      },
    })
    pool = postgresClient.pool

    // Clean up test data before running tests
    await pool.query('DELETE FROM stripe._sync_status WHERE resource LIKE $1', ['test_%'])
  })

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM stripe._sync_status WHERE resource LIKE $1', ['test_%'])
    await pool.end()
  })

  describe('getSyncCursor', () => {
    it('should return null for new resource with no cursor', async () => {
      const cursor = await postgresClient.getSyncCursor('test_products_new', testAccountId)
      expect(cursor).toBeNull()
    })

    it('should retrieve cursor after it has been set', async () => {
      const resource = 'test_products_retrieve'
      const expectedCursor = 1704902400

      await postgresClient.updateSyncCursor(resource, testAccountId, expectedCursor)
      const cursor = await postgresClient.getSyncCursor(resource, testAccountId)

      expect(cursor).toBe(expectedCursor)
    })
  })

  describe('updateSyncCursor', () => {
    it('should create new sync status entry', async () => {
      const resource = 'test_products_create'
      const cursor = 1704902400

      await postgresClient.updateSyncCursor(resource, testAccountId, cursor)

      const result = await pool.query(
        `SELECT *, EXTRACT(EPOCH FROM last_incremental_cursor)::integer as cursor_epoch
         FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2`,
        [resource, testAccountId]
      )

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].resource).toBe(resource)
      expect(result.rows[0].account_id).toBe(testAccountId)
      expect(result.rows[0].cursor_epoch).toBe(cursor)
      expect(result.rows[0].status).toBe('running')
    })

    it('should update existing cursor value', async () => {
      const resource = 'test_products_update'
      const initialCursor = 1704902400
      const updatedCursor = 1705000000

      await postgresClient.updateSyncCursor(resource, testAccountId, initialCursor)
      await postgresClient.updateSyncCursor(resource, testAccountId, updatedCursor)

      const cursor = await postgresClient.getSyncCursor(resource, testAccountId)
      expect(cursor).toBe(updatedCursor)
    })

    it('should update last_synced_at timestamp', async () => {
      const resource = 'test_products_timestamp'
      const cursor = 1704902400

      const beforeTime = new Date()
      await postgresClient.updateSyncCursor(resource, testAccountId, cursor)
      const afterTime = new Date()

      const result = await pool.query(
        'SELECT last_synced_at FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      const lastSyncedAt = new Date(result.rows[0].last_synced_at)
      expect(lastSyncedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime())
      expect(lastSyncedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime())
    })
  })

  describe('markSyncRunning', () => {
    it('should set status to running for new resource', async () => {
      const resource = 'test_products_running_new'

      await postgresClient.markSyncRunning(resource, testAccountId)

      const result = await pool.query(
        'SELECT status FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('running')
    })

    it('should update status to running for existing resource', async () => {
      const resource = 'test_products_running_existing'

      await postgresClient.markSyncComplete(resource, testAccountId)
      await postgresClient.markSyncRunning(resource, testAccountId)

      const result = await pool.query(
        'SELECT status FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('running')
    })
  })

  describe('markSyncComplete', () => {
    it('should set status to complete', async () => {
      const resource = 'test_products_complete'

      await postgresClient.markSyncRunning(resource, testAccountId)
      await postgresClient.markSyncComplete(resource, testAccountId)

      const result = await pool.query(
        'SELECT status, error_message FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('complete')
      expect(result.rows[0].error_message).toBeNull()
    })

    it('should clear error_message when marking complete', async () => {
      const resource = 'test_products_clear_error'

      await postgresClient.markSyncError(resource, testAccountId, 'Test error')
      await postgresClient.markSyncComplete(resource, testAccountId)

      const result = await pool.query(
        'SELECT error_message FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      expect(result.rows[0].error_message).toBeNull()
    })
  })

  describe('markSyncError', () => {
    it('should set status to error with error message', async () => {
      const resource = 'test_products_error'
      const errorMessage = 'Test error message'

      await postgresClient.markSyncRunning(resource, testAccountId)
      await postgresClient.markSyncError(resource, testAccountId, errorMessage)

      const result = await pool.query(
        'SELECT status, error_message FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toBe(errorMessage)
    })

    it('should preserve cursor when marking error', async () => {
      const resource = 'test_products_preserve_cursor'
      const cursor = 1704902400
      const errorMessage = 'Test error'

      await postgresClient.updateSyncCursor(resource, testAccountId, cursor)
      await postgresClient.markSyncError(resource, testAccountId, errorMessage)

      const retrievedCursor = await postgresClient.getSyncCursor(resource, testAccountId)
      expect(retrievedCursor).toBe(cursor)
    })
  })

  describe('status transitions', () => {
    it('should follow complete workflow: running → complete', async () => {
      const resource = 'test_workflow_success'
      const cursor = 1704902400

      await postgresClient.markSyncRunning(resource, testAccountId)
      await postgresClient.updateSyncCursor(resource, testAccountId, cursor)
      await postgresClient.markSyncComplete(resource, testAccountId)

      const result = await pool.query(
        `SELECT status, EXTRACT(EPOCH FROM last_incremental_cursor)::integer as cursor_epoch
         FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2`,
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('complete')
      expect(result.rows[0].cursor_epoch).toBe(cursor)
    })

    it('should follow error workflow: running → error → running → complete', async () => {
      const resource = 'test_workflow_recovery'
      const initialCursor = 1704902400
      const finalCursor = 1705000000

      // First attempt fails
      await postgresClient.markSyncRunning(resource, testAccountId)
      await postgresClient.updateSyncCursor(resource, testAccountId, initialCursor)
      await postgresClient.markSyncError(resource, testAccountId, 'First attempt failed')

      // Second attempt succeeds
      await postgresClient.markSyncRunning(resource, testAccountId)
      await postgresClient.updateSyncCursor(resource, testAccountId, finalCursor)
      await postgresClient.markSyncComplete(resource, testAccountId)

      const result = await pool.query(
        `SELECT status, EXTRACT(EPOCH FROM last_incremental_cursor)::integer as cursor_epoch, error_message
         FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2`,
        [resource, testAccountId]
      )

      expect(result.rows[0].status).toBe('complete')
      expect(result.rows[0].cursor_epoch).toBe(finalCursor)
      expect(result.rows[0].error_message).toBeNull()
    })

    it('should isolate cursors between different accounts', async () => {
      const resource = 'test_multi_account'
      const account1 = 'acct_test_1'
      const account2 = 'acct_test_2'
      const cursor1 = 1704902400
      const cursor2 = 1705000000

      // Set different cursors for same resource but different accounts
      await postgresClient.updateSyncCursor(resource, account1, cursor1)
      await postgresClient.updateSyncCursor(resource, account2, cursor2)

      // Verify each account has its own cursor
      const retrievedCursor1 = await postgresClient.getSyncCursor(resource, account1)
      const retrievedCursor2 = await postgresClient.getSyncCursor(resource, account2)

      expect(retrievedCursor1).toBe(cursor1)
      expect(retrievedCursor2).toBe(cursor2)
    })
  })

  describe('Advisory Lock Methods', () => {
    it('should acquire and release advisory locks correctly', async () => {
      const testKey = 'test-lock-key'

      // Acquire lock
      await postgresClient.acquireAdvisoryLock(testKey)

      // Release lock
      await postgresClient.releaseAdvisoryLock(testKey)

      // Should be able to acquire again after release
      await postgresClient.acquireAdvisoryLock(testKey)
      await postgresClient.releaseAdvisoryLock(testKey)
    })

    it('should execute function with advisory lock using withAdvisoryLock', async () => {
      const testKey = 'test-with-lock-key'
      let executed = false

      const result = await postgresClient.withAdvisoryLock(testKey, async () => {
        executed = true
        return 'success'
      })

      expect(executed).toBe(true)
      expect(result).toBe('success')
    })

    it('should release lock even if function throws error', async () => {
      const testKey = 'test-error-lock-key'

      // Try to execute function that throws
      await expect(
        postgresClient.withAdvisoryLock(testKey, async () => {
          throw new Error('Test error')
        })
      ).rejects.toThrow('Test error')

      // Lock should be released, so we can acquire it again
      await postgresClient.acquireAdvisoryLock(testKey)
      await postgresClient.releaseAdvisoryLock(testKey)
    })

    it('should hash different keys to different lock IDs', () => {
      const hash1 = postgresClient['hashToInt32']('key1')
      const hash2 = postgresClient['hashToInt32']('key2')
      const hash3 = postgresClient['hashToInt32']('key1') // Same as hash1

      expect(hash1).not.toBe(hash2)
      expect(hash1).toBe(hash3)
    })
  })
})
