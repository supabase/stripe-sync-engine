import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSync } from './stripeSync'

/**
 * Regression tests for pagination behavior.
 *
 * These tests ensure that objects with supportsCreatedFilter: true
 * correctly pass the `created` filter to Stripe API, preventing
 * infinite loops where the same records are fetched repeatedly.
 *
 * Bug context: credit_notes was incorrectly marked as supportsCreatedFilter: false,
 * causing infinite pagination loops (fetching same 100 records over and over).
 */
describe('Pagination regression tests', () => {
  describe('credit_notes supportsCreatedFilter', () => {
    it('should have supportsCreatedFilter: true for credit_note', () => {
      // Create a minimal StripeSync instance to check the registry
      // We'll access the private resourceRegistry through the object
      const sync = new StripeSync({
        stripeSecretKey: 'sk_test_fake',
        databaseUrl: 'postgresql://fake',
        poolConfig: {},
      })

      // Access private resourceRegistry for testing
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registry = (sync as any).resourceRegistry

      // credit_note MUST support created filter to enable incremental sync
      // If this is false, pagination will loop infinitely
      expect(registry.credit_note.supportsCreatedFilter).toBe(true)
    })

    it('should have supportsCreatedFilter: true for all objects except payment_method and tax_id', () => {
      const sync = new StripeSync({
        stripeSecretKey: 'sk_test_fake',
        databaseUrl: 'postgresql://fake',
        poolConfig: {},
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registry = (sync as any).resourceRegistry

      // Objects that legitimately don't support created filter
      // (either require customer context, or are Sigma-backed tables)
      const expectedFalse = [
        'payment_method',
        'tax_id',
        'subscription_item_change_events_v2_beta', // Sigma-backed table
        'exchange_rates_from_usd', // Sigma-backed table
      ]

      for (const [objectName, config] of Object.entries(registry)) {
        const resourceConfig = config as { supportsCreatedFilter: boolean }
        if (expectedFalse.includes(objectName)) {
          expect(
            resourceConfig.supportsCreatedFilter,
            `${objectName} should have supportsCreatedFilter: false`
          ).toBe(false)
        } else {
          expect(
            resourceConfig.supportsCreatedFilter,
            `${objectName} should have supportsCreatedFilter: true to prevent infinite pagination`
          ).toBe(true)
        }
      }
    })
  })

  describe('fetchOnePage pagination behavior', () => {
    let sync: StripeSync
    let mockCreditNotesList: ReturnType<typeof vi.fn>

    beforeEach(() => {
      sync = new StripeSync({
        stripeSecretKey: 'sk_test_fake',
        databaseUrl: 'postgresql://fake',
        poolConfig: {},
      })

      // Mock the Stripe creditNotes.list method
      mockCreditNotesList = vi.fn().mockResolvedValue({
        data: [
          { id: 'cn_1', created: 1700000100 },
          { id: 'cn_2', created: 1700000200 },
        ],
        has_more: false,
      })

      // Replace the stripe client's creditNotes methods
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sync.stripe as any).creditNotes = {
        list: mockCreditNotesList,
        listLineItems: vi.fn().mockResolvedValue({ data: [] }),
      }

      // Mock getCurrentAccount to avoid Stripe API call
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sync as any).getCurrentAccount = vi.fn().mockResolvedValue({
        id: 'acct_test',
      })

      // Mock postgres methods to avoid DB calls
      sync.postgresClient.getOrCreateSyncRun = vi.fn().mockResolvedValue({
        started_at: new Date(),
        status: 'running',
      })
      sync.postgresClient.createObjectRuns = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.getObjectRun = vi.fn().mockResolvedValue({
        status: 'running',
        cursor: '1700000000', // Existing cursor (timestamp)
      })
      sync.postgresClient.tryStartObjectSync = vi.fn().mockResolvedValue(true)
      sync.postgresClient.getOrCreateObjectRun = vi.fn().mockResolvedValue({
        status: 'running',
        cursor: '1700000000', // Existing cursor (timestamp)
      })
      sync.postgresClient.getLastCompletedCursor = vi.fn().mockResolvedValue(null)
      sync.postgresClient.incrementObjectProgress = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.updateObjectCursor = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.completeObjectSync = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.failObjectSync = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.upsert = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.upsertManyWithTimestampProtection = vi.fn().mockResolvedValue([])
    })

    it('should pass created filter when supportsCreatedFilter is true and cursor exists', async () => {
      // Call processNext for credit_note
      await sync.processNext('credit_note', 'acct_test')

      // Verify that creditNotes.list was called with created filter
      expect(mockCreditNotesList).toHaveBeenCalledTimes(1)
      const callArgs = mockCreditNotesList.mock.calls[0][0]

      expect(callArgs).toMatchObject({
        limit: 100,
        created: { gte: 1700000000 }, // Should use cursor as created filter
      })
    })

    it('should NOT have starting_after when using created filter', async () => {
      await sync.processNext('credit_note', 'acct_test')

      const callArgs = mockCreditNotesList.mock.calls[0][0]

      // When using created filter, starting_after should NOT be present
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('should update cursor with max created timestamp from response', async () => {
      await sync.processNext('credit_note', 'acct_test')

      // Should update cursor with max created (1700000200)
      // The key assertion is that the cursor value is the MAX timestamp from the response
      expect(sync.postgresClient.updateObjectCursor).toHaveBeenCalled()
      const updateCursorCall = vi.mocked(sync.postgresClient.updateObjectCursor).mock.calls[0]
      expect(updateCursorCall[0]).toBe('acct_test') // accountId
      expect(updateCursorCall[2]).toBe('credit_notes') // resourceName
      expect(updateCursorCall[3]).toBe('1700000200') // cursor = max(created) from response
    })
  })
})
