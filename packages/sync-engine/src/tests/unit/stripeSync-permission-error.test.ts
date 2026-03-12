import { describe, it, expect, vi } from 'vitest'
import { createMockedStripeSync } from '../testSetup'
import type { RunKey } from '../../stripeSync'

/**
 * Tests for object-level permission error isolation during sync initialization.
 *
 * When one Stripe object's listFn throws a permission error (e.g. coupon with
 * more_permissions_required_for_application), createChunks() should isolate
 * the failure so other objects can still proceed, and initializeSegment()
 * should record the failed object as errored rather than aborting the whole run.
 */
describe('permission error isolation in sync initialization', () => {
  describe('createChunks', () => {
    it('should return failed objects when a listFn throws a permission error', async () => {
      const sync = await createMockedStripeSync()

      // Make coupon's listFn throw a permission error
      const permissionError = new Error(
        'This application does not have the required permissions for this endpoint'
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(permissionError as any).type = 'StripePermissionError'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(permissionError as any).code = 'more_permissions_required_for_application'

      vi.spyOn(sync, 'findOldestItem').mockImplementation(async (listFn) => {
        void listFn
        throw permissionError
      })

      const result = await sync.createChunks(['coupon'], 10)

      expect(result.failedObjects).toHaveLength(1)
      expect(result.failedObjects[0].tableName).toBe('coupons')
      expect(result.failedObjects[0].error).toContain('does not have the required permissions')
    })

    it('should not include failed objects in nonChunkTables', async () => {
      const sync = await createMockedStripeSync()

      // Make coupon's listFn throw but customer's succeed with no items (null)
      vi.spyOn(sync, 'findOldestItem').mockImplementation(async (listFn) => {
        void listFn
        throw new Error('Permission denied')
      })

      const result = await sync.createChunks(['coupon'], 10)

      expect(result.nonChunkTables).not.toContain('coupons')
      expect(result.failedObjects).toHaveLength(1)
      expect(result.failedObjects[0].tableName).toBe('coupons')
    })

    it('should allow other objects to proceed when one object fails', async () => {
      const sync = await createMockedStripeSync()

      // coupon has supportsCreatedFilter: true and a listFn
      // customer also has supportsCreatedFilter: true and a listFn
      // Make only coupon's probe throw
      const couponListFn = sync.resourceRegistry['coupon']?.listFn
      const customerListFn = sync.resourceRegistry['customer']?.listFn

      vi.spyOn(sync, 'findOldestItem').mockImplementation(async (listFn) => {
        if (listFn === couponListFn) {
          throw new Error('Permission denied for coupon')
        }
        if (listFn === customerListFn) {
          // Return null means "no items found" → goes to nonChunkTables
          return null
        }
        return null
      })

      const result = await sync.createChunks(['coupon', 'customer'], 10)

      // coupon should be in failedObjects, not in nonChunkTables
      expect(result.failedObjects).toHaveLength(1)
      expect(result.failedObjects[0].tableName).toBe('coupons')
      expect(result.nonChunkTables).not.toContain('coupons')

      // customer returned null (no items), so it goes to nonChunkTables as normal
      expect(result.nonChunkTables).toContain('customers')
    })

    it('should not fail the whole Promise.all when one listFn throws', async () => {
      const sync = await createMockedStripeSync()

      const couponListFn = sync.resourceRegistry['coupon']?.listFn

      vi.spyOn(sync, 'findOldestItem').mockImplementation(async (listFn) => {
        if (listFn === couponListFn) {
          throw new Error('Stripe permission error')
        }
        return null
      })

      // This should NOT throw even though coupon's probe throws
      await expect(sync.createChunks(['coupon', 'customer', 'charge'], 10)).resolves.toBeDefined()
    })
  })

  describe('initializeSegment', () => {
    it('should create errored object runs for failed objects and proceed with others', async () => {
      const sync = await createMockedStripeSync()

      const runKey: RunKey = {
        accountId: 'acct_test',
        runStartedAt: new Date('2024-01-01T00:00:00Z'),
      }

      // Mock createChunks to return one failed object
      vi.spyOn(sync, 'createChunks').mockResolvedValue({
        chunkCursors: {},
        nonChunkTables: ['customers'],
        failedObjects: [{ tableName: 'coupons', error: 'Error: Permission denied' }],
      })

      // Mock postgres client methods
      const mockCreateChunkedObjectRuns = vi.fn().mockResolvedValue(undefined)
      const mockCreateObjectRuns = vi.fn().mockResolvedValue(undefined)
      const mockFailObjectSync = vi.fn().mockResolvedValue(undefined)

      sync.postgresClient.createChunkedObjectRuns = mockCreateChunkedObjectRuns
      sync.postgresClient.createObjectRuns = mockCreateObjectRuns
      sync.postgresClient.failObjectSync = mockFailObjectSync

      await sync.initializeSegment(runKey, ['coupon', 'customer'], 10)

      // createObjectRuns should be called for both the normal nonChunkTables and the failed object
      expect(mockCreateObjectRuns).toHaveBeenCalledTimes(2)

      // First call: normal nonChunkTables (customers)
      expect(mockCreateObjectRuns).toHaveBeenCalledWith(
        runKey.accountId,
        runKey.runStartedAt,
        ['customers'],
        expect.any(Object)
      )
      // Second call: failed object (coupons), to create the run before marking it errored
      expect(mockCreateObjectRuns).toHaveBeenCalledWith(
        runKey.accountId,
        runKey.runStartedAt,
        ['coupons'],
        expect.any(Object)
      )

      // failObjectSync should be called for the failed object
      expect(mockFailObjectSync).toHaveBeenCalledTimes(1)
      expect(mockFailObjectSync).toHaveBeenCalledWith(
        runKey.accountId,
        runKey.runStartedAt,
        'coupons',
        expect.stringContaining('Initialization failed:')
      )
    })

    it('should not call failObjectSync when there are no failed objects', async () => {
      const sync = await createMockedStripeSync()

      const runKey: RunKey = {
        accountId: 'acct_test',
        runStartedAt: new Date('2024-01-01T00:00:00Z'),
      }

      vi.spyOn(sync, 'createChunks').mockResolvedValue({
        chunkCursors: {},
        nonChunkTables: ['customers'],
        failedObjects: [],
      })

      const mockCreateChunkedObjectRuns = vi.fn().mockResolvedValue(undefined)
      const mockCreateObjectRuns = vi.fn().mockResolvedValue(undefined)
      const mockFailObjectSync = vi.fn().mockResolvedValue(undefined)

      sync.postgresClient.createChunkedObjectRuns = mockCreateChunkedObjectRuns
      sync.postgresClient.createObjectRuns = mockCreateObjectRuns
      sync.postgresClient.failObjectSync = mockFailObjectSync

      await sync.initializeSegment(runKey, ['customer'], 10)

      expect(mockFailObjectSync).not.toHaveBeenCalled()
    })
  })
})
