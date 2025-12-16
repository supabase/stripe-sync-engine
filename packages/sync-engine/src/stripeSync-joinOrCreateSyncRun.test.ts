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

  beforeEach(() => {
    sync = new StripeSync({
      stripeSecretKey: 'sk_test_fake',
      databaseUrl: 'postgresql://fake',
    })

    // Mock methods
    mockGetOrCreateSyncRun = vi.fn()
    mockGetActiveSyncRun = vi.fn()
    mockGetCurrentAccount = vi.fn().mockResolvedValue({ id: 'acct_123' })

    sync.postgresClient.getOrCreateSyncRun = mockGetOrCreateSyncRun
    sync.postgresClient.getActiveSyncRun = mockGetActiveSyncRun
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
})
