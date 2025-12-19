import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSync } from './stripeSync'

/**
 * Unit tests for joinOrCreateSyncRun() method.
 *
 * joinOrCreateSyncRun() creates a sync run to make enqueued work visible
 * (status='pending') before processing begins, or joins an existing run.
 * This is used by workers and background processes that should cooperate.
 */
describe('joinOrCreateSyncRun', () => {
  let sync: StripeSync
  let mockGetOrCreateSyncRun: ReturnType<typeof vi.fn>
  let mockGetActiveSyncRun: ReturnType<typeof vi.fn>
  let mockGetCurrentAccount: ReturnType<typeof vi.fn>
  let mockCreateObjectRuns: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sync = new StripeSync({
      stripeSecretKey: 'sk_test_fake',
      databaseUrl: 'postgresql://fake',
      poolConfig: {},
    })

    // Mock methods
    mockGetOrCreateSyncRun = vi.fn()
    mockGetActiveSyncRun = vi.fn()
    mockGetCurrentAccount = vi.fn().mockResolvedValue({ id: 'acct_123' })
    mockCreateObjectRuns = vi.fn().mockResolvedValue(undefined)

    sync.postgresClient.getOrCreateSyncRun = mockGetOrCreateSyncRun
    sync.postgresClient.getActiveSyncRun = mockGetActiveSyncRun
    sync.postgresClient.createObjectRuns = mockCreateObjectRuns
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync as any).getCurrentAccount = mockGetCurrentAccount
  })

  it('should create sync run and return supported objects', async () => {
    const mockRunKey = {
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
      isNew: true,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(mockRunKey)

    const result = await sync.joinOrCreateSyncRun('test')

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'test')
    expect(result.runKey).toEqual({
      accountId: mockRunKey.accountId,
      runStartedAt: mockRunKey.runStartedAt,
    })
    expect(result.objects).toContain('customer')
    expect(result.objects).toContain('product')
    expect(result.objects.length).toBeGreaterThan(0)
  })

  it('should handle race condition when run already exists', async () => {
    // getOrCreateSyncRun returns null (race condition)
    mockGetOrCreateSyncRun.mockResolvedValue(null)

    // getActiveSyncRun returns the existing run
    mockGetActiveSyncRun.mockResolvedValue({
      accountId: 'acct_123',
      runStartedAt: new Date('2024-01-01T00:00:00Z'),
    })

    const result = await sync.joinOrCreateSyncRun('test')

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'test')
    expect(mockGetActiveSyncRun).toHaveBeenCalledWith('acct_123')
    expect(result.runKey.accountId).toBe('acct_123')
    expect(result.objects.length).toBeGreaterThan(0)
  })

  it('should throw error when both getOrCreateSyncRun and getActiveSyncRun fail', async () => {
    mockGetOrCreateSyncRun.mockResolvedValue(null)
    mockGetActiveSyncRun.mockResolvedValue(null)

    await expect(sync.joinOrCreateSyncRun('test')).rejects.toThrow(
      'Failed to get or create sync run'
    )
  })

  it('should use default triggeredBy value of "worker" if not provided', async () => {
    const mockRunKey = {
      accountId: 'acct_123',
      runStartedAt: new Date(),
      isNew: true,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(mockRunKey)

    await sync.joinOrCreateSyncRun()

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'worker')
  })

  it('should allow custom triggeredBy value', async () => {
    const mockRunKey = {
      accountId: 'acct_123',
      runStartedAt: new Date(),
      isNew: true,
    }
    mockGetOrCreateSyncRun.mockResolvedValue(mockRunKey)

    await sync.joinOrCreateSyncRun('manual')

    expect(mockGetOrCreateSyncRun).toHaveBeenCalledWith('acct_123', 'manual')
  })

  describe('Object Type vs Resource Name Footgun Prevention', () => {
    it('should call createObjectRuns with resource names (plural), not object types (singular)', async () => {
      const mockRunKey = {
        accountId: 'acct_123',
        runStartedAt: new Date('2024-01-01T00:00:00Z'),
        isNew: true,
      }
      mockGetOrCreateSyncRun.mockResolvedValue(mockRunKey)

      await sync.joinOrCreateSyncRun('test')

      // Verify createObjectRuns was called
      expect(mockCreateObjectRuns).toHaveBeenCalledTimes(1)

      // Get the arguments passed to createObjectRuns
      const [accountId, runStartedAt, resourceNames] = mockCreateObjectRuns.mock.calls[0]

      expect(accountId).toBe('acct_123')
      expect(runStartedAt).toEqual(mockRunKey.runStartedAt)

      // CRITICAL: Verify resource names (plural) are passed, not object types (singular)
      expect(resourceNames).toBeInstanceOf(Array)
      expect(resourceNames.length).toBeGreaterThan(0)

      // Should contain resource names (plural)
      expect(resourceNames).toContain('products') // NOT 'product'
      expect(resourceNames).toContain('customers') // NOT 'customer'
      expect(resourceNames).toContain('prices') // NOT 'price'

      // Should NOT contain object types (singular) - this would be the footgun
      expect(resourceNames).not.toContain('product')
      expect(resourceNames).not.toContain('customer')
      expect(resourceNames).not.toContain('price')

      // All resource names should be strings
      resourceNames.forEach((name: string) => {
        expect(typeof name).toBe('string')
      })
    })

    it('should call createObjectRuns with resource names when joining existing run', async () => {
      // Simulate race condition - getOrCreateSyncRun returns null
      mockGetOrCreateSyncRun.mockResolvedValue(null)

      // getActiveSyncRun returns existing run
      const existingRun = {
        accountId: 'acct_123',
        runStartedAt: new Date('2024-01-01T00:00:00Z'),
      }
      mockGetActiveSyncRun.mockResolvedValue(existingRun)

      await sync.joinOrCreateSyncRun('test')

      // Verify createObjectRuns was called for existing run too
      expect(mockCreateObjectRuns).toHaveBeenCalledTimes(1)

      const [, , resourceNames] = mockCreateObjectRuns.mock.calls[0]

      // Same verification - should be resource names (plural)
      expect(resourceNames).toContain('products')
      expect(resourceNames).toContain('customers')
      expect(resourceNames).not.toContain('product')
      expect(resourceNames).not.toContain('customer')
    })

    it('should match resource names with what processNext expects', async () => {
      // This test documents the contract: joinOrCreateSyncRun creates object runs
      // using resource names that processNext will later query by

      const mockRunKey = {
        accountId: 'acct_123',
        runStartedAt: new Date(),
        isNew: true,
      }
      mockGetOrCreateSyncRun.mockResolvedValue(mockRunKey)

      const result = await sync.joinOrCreateSyncRun('test')

      // Get the resource names passed to createObjectRuns
      const [, , resourceNames] = mockCreateObjectRuns.mock.calls[0]

      // Get the object types returned in the result
      const { objects } = result

      // For each object type returned, verify corresponding resource name was created
      objects.forEach((objectType) => {
        // Convert object type to resource name using same logic as the implementation
        const expectedResourceName =
          objectType === 'customer'
            ? 'customers'
            : objectType === 'product'
              ? 'products'
              : objectType === 'price'
                ? 'prices'
                : objectType === 'invoice'
                  ? 'invoices'
                  : objectType.endsWith('s')
                    ? objectType
                    : objectType + 's'

        // Verify that resource name exists in what was passed to createObjectRuns
        expect(resourceNames).toContain(expectedResourceName)
      })

      // This ensures no mismatch between:
      // 1. What joinOrCreateSyncRun creates in DB (resource names)
      // 2. What processNext will query for (resource names derived from object types)
    })
  })
})
