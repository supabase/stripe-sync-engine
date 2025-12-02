import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgresClient } from './postgres'
import { runMigrations } from './migrate'
import { PgAdapter } from './pg-adapter'

describe('Observable Sync System Methods', () => {
  let postgresClient: PostgresClient
  let adapter: PgAdapter
  const testAccountId = 'acct_test_obs_123'

  beforeAll(async () => {
    const databaseUrl =
      process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:54322/postgres'

    // Run migrations to ensure schema and tables exist
    await runMigrations({ databaseUrl })

    adapter = new PgAdapter({
      connectionString: databaseUrl,
    })

    postgresClient = new PostgresClient({
      schema: 'stripe',
      adapter,
    })

    // Ensure test account exists using the proper method
    await postgresClient.upsertAccount(
      { id: testAccountId, raw_data: { id: testAccountId, object: 'account' } },
      `test_api_key_hash_${testAccountId}`
    )
  })

  afterAll(async () => {
    // Clean up test data
    await adapter.query('DELETE FROM stripe._sync_obj_run WHERE "_account_id" = $1', [
      testAccountId,
    ])
    await adapter.query('DELETE FROM stripe._sync_run WHERE "_account_id" = $1', [testAccountId])
    await adapter.end()
  })

  beforeEach(async () => {
    // Clean up between tests
    await adapter.query('DELETE FROM stripe._sync_obj_run WHERE "_account_id" = $1', [
      testAccountId,
    ])
    await adapter.query('DELETE FROM stripe._sync_run WHERE "_account_id" = $1', [testAccountId])
  })

  describe('getOrCreateSyncRun', () => {
    it('should create a new run when none exists', async () => {
      const result = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      expect(result).not.toBeNull()
      expect(result!.accountId).toBe(testAccountId)
      expect(result!.isNew).toBe(true)
      expect(result!.runStartedAt).toBeInstanceOf(Date)
    })

    it('should return existing run when one is active', async () => {
      const first = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      const second = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      expect(second).not.toBeNull()
      expect(second!.isNew).toBe(false)
      expect(second!.runStartedAt.getTime()).toBe(first!.runStartedAt.getTime())
    })

    it('should enforce single active run per account with EXCLUDE constraint', async () => {
      // Create first run
      await postgresClient.getOrCreateSyncRun(testAccountId, 'test')

      // Try to insert directly (bypassing the check)
      await expect(
        adapter.query(
          `INSERT INTO stripe._sync_run ("_account_id", triggered_by) VALUES ($1, 'test')`,
          [testAccountId]
        )
      ).rejects.toThrow(/one_active_run_per_account/)
    })
  })

  describe('getActiveSyncRun', () => {
    it('should return null when no active run', async () => {
      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).toBeNull()
    })

    it('should return active run when one exists', async () => {
      const created = await postgresClient.getOrCreateSyncRun(testAccountId)

      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).not.toBeNull()
      expect(result!.runStartedAt.getTime()).toBe(created!.runStartedAt.getTime())
    })

    it('should not return completed runs', async () => {
      const created = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.completeSyncRun(created!.accountId, created!.runStartedAt)

      const result = await postgresClient.getActiveSyncRun(testAccountId)
      expect(result).toBeNull()
    })
  })

  describe('completeSyncRun', () => {
    it('should mark run as complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.completeSyncRun(run!.accountId, run!.runStartedAt)

      const result = await adapter.query<{ status: string; completed_at: Date }>(
        `SELECT status, completed_at FROM stripe._sync_run
         WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('complete')
      expect(result.rows[0].completed_at).not.toBeNull()
    })
  })

  describe('failSyncRun', () => {
    it('should mark run as error with message', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.failSyncRun(run!.accountId, run!.runStartedAt, 'Test error')

      const result = await adapter.query<{
        status: string
        error_message: string
        completed_at: Date
      }>(
        `SELECT status, error_message, completed_at FROM stripe._sync_run
         WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toBe('Test error')
      expect(result.rows[0].completed_at).not.toBeNull()
    })
  })

  describe('createObjectRuns', () => {
    it('should create object run entries for each object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      const objects = ['customer', 'invoice', 'subscription']

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, objects)

      const result = await adapter.query<{ object: string; status: string }>(
        `SELECT object, status FROM stripe._sync_obj_run
         WHERE "_account_id" = $1 AND run_started_at = $2
         ORDER BY object`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows).toHaveLength(3)
      expect(result.rows[0].object).toBe('customer')
      expect(result.rows[0].status).toBe('pending')
      expect(result.rows[1].object).toBe('invoice')
      expect(result.rows[2].object).toBe('subscription')
    })

    it('should not fail on duplicate objects (ON CONFLICT DO NOTHING)', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)

      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      const result = await adapter.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM stripe._sync_obj_run
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = 'customer'`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(parseInt(result.rows[0].count)).toBe(1)
    })
  })

  describe('tryStartObjectSync', () => {
    it('should claim a pending object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      const result = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )

      expect(result).toBe(true)

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.status).toBe('running')
    })

    it('should not claim an already running object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const result = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )

      expect(result).toBe(false)
    })

    it('should respect max_concurrent limit', async () => {
      // Create run with max_concurrent = 2
      // Use date_trunc for JS Date compatibility
      await adapter.query(
        `INSERT INTO stripe._sync_run ("_account_id", max_concurrent, started_at)
         VALUES ($1, 2, date_trunc('milliseconds', now()))`,
        [testAccountId]
      )
      const run = await postgresClient.getActiveSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
        'subscription',
      ])

      // Start first two objects
      const r1 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )
      const r2 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'invoice'
      )

      // Third should fail due to limit
      const r3 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'subscription'
      )

      expect(r1).toBe(true)
      expect(r2).toBe(true)
      expect(r3).toBe(false)
    })
  })

  describe('incrementObjectProgress', () => {
    it('should increment processed count', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        100
      )
      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        50
      )

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.processedCount).toBe(150)
    })
  })

  describe('updateObjectCursor', () => {
    it('should update cursor value', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])

      await postgresClient.updateObjectCursor(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'cus_abc123'
      )

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.cursor).toBe('cus_abc123')
    })
  })

  describe('completeObjectSync', () => {
    it('should mark object as complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const obj = await postgresClient.getObjectRun(run!.accountId, run!.runStartedAt, 'customer')
      expect(obj!.status).toBe('complete')
    })
  })

  describe('failObjectSync', () => {
    it('should mark object as error with message', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.failObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'API error'
      )

      const result = await adapter.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM stripe._sync_obj_run
         WHERE "_account_id" = $1 AND run_started_at = $2 AND object = 'customer'`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toBe('API error')
    })
  })

  describe('countRunningObjects', () => {
    it('should count running objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
        'subscription',
      ])

      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(0)

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(1)

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(2)

      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.countRunningObjects(run!.accountId, run!.runStartedAt)).toBe(1)
    })
  })

  describe('getNextPendingObject', () => {
    it('should return next pending object', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBe('customer')
    })

    it('should return null when no pending objects', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBeNull()
    })

    it('should return null when at concurrency limit', async () => {
      // Create run with max_concurrent = 1
      // Use date_trunc for JS Date compatibility
      await adapter.query(
        `INSERT INTO stripe._sync_run ("_account_id", max_concurrent, started_at)
         VALUES ($1, 1, date_trunc('milliseconds', now()))`,
        [testAccountId]
      )
      const run = await postgresClient.getActiveSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      const next = await postgresClient.getNextPendingObject(run!.accountId, run!.runStartedAt)
      expect(next).toBeNull()
    })
  })

  describe('areAllObjectsComplete', () => {
    it('should return true when all objects complete', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        false
      )

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        false
      )

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        true
      )
    })

    it('should return true when all objects are complete or error', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'invoice')
      await postgresClient.failObjectSync(run!.accountId, run!.runStartedAt, 'invoice', 'error')

      expect(await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)).toBe(
        true
      )
    })
  })

  describe('cancelStaleRuns', () => {
    it('should cancel runs with stale objects', async () => {
      // Create a run
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      // Manually set updated_at to 10 minutes ago (stale)
      // Must disable trigger first as it overwrites updated_at with now()
      await adapter.query(`ALTER TABLE stripe._sync_obj_run DISABLE TRIGGER handle_updated_at`)
      await adapter.query(
        `UPDATE stripe._sync_obj_run
         SET updated_at = now() - interval '10 minutes'
         WHERE "_account_id" = $1`,
        [run!.accountId]
      )
      await adapter.query(`ALTER TABLE stripe._sync_obj_run ENABLE TRIGGER handle_updated_at`)

      // Call cancelStaleRuns
      await postgresClient.cancelStaleRuns(testAccountId)

      // Check run is now error
      const result = await adapter.query<{ status: string; error_message: string }>(
        `SELECT status, error_message FROM stripe._sync_run
         WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('error')
      expect(result.rows[0].error_message).toContain('stale')
    })

    it('should not cancel runs with recent activity', async () => {
      const run = await postgresClient.getOrCreateSyncRun(testAccountId)
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, ['customer'])
      await postgresClient.tryStartObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      // Call cancelStaleRuns (should not cancel because updated_at is recent)
      await postgresClient.cancelStaleRuns(testAccountId)

      // Check run is still running
      const result = await adapter.query<{ status: string }>(
        `SELECT status FROM stripe._sync_run
         WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )

      expect(result.rows[0].status).toBe('running')
    })
  })

  describe('full sync workflow', () => {
    it('should complete a full sync cycle', async () => {
      // 1. Create run
      const run = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(run!.isNew).toBe(true)

      // 2. Create object runs
      await postgresClient.createObjectRuns(run!.accountId, run!.runStartedAt, [
        'customer',
        'invoice',
      ])

      // 3. Process customers
      const started1 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'customer'
      )
      expect(started1).toBe(true)
      await postgresClient.incrementObjectProgress(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        100
      )
      await postgresClient.updateObjectCursor(
        run!.accountId,
        run!.runStartedAt,
        'customer',
        'cus_last'
      )
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'customer')

      // 4. Process invoices
      const started2 = await postgresClient.tryStartObjectSync(
        run!.accountId,
        run!.runStartedAt,
        'invoice'
      )
      expect(started2).toBe(true)
      await postgresClient.incrementObjectProgress(run!.accountId, run!.runStartedAt, 'invoice', 50)
      await postgresClient.completeObjectSync(run!.accountId, run!.runStartedAt, 'invoice')

      // 5. Check all complete
      const allDone = await postgresClient.areAllObjectsComplete(run!.accountId, run!.runStartedAt)
      expect(allDone).toBe(true)

      // 6. Complete run
      await postgresClient.completeSyncRun(run!.accountId, run!.runStartedAt)

      // 7. Verify final state
      const finalRun = await adapter.query<{ status: string }>(
        `SELECT status FROM stripe._sync_run
         WHERE "_account_id" = $1 AND started_at = $2`,
        [run!.accountId, run!.runStartedAt]
      )
      expect(finalRun.rows[0].status).toBe('complete')

      // 8. Can start a new run now
      const newRun = await postgresClient.getOrCreateSyncRun(testAccountId, 'test')
      expect(newRun!.isNew).toBe(true)
    })
  })
})
