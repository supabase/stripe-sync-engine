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
        accountId: 'acct_test',
        runStartedAt: new Date(),
        isNew: true,
      })
      sync.postgresClient.createObjectRuns = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.getObjectRun = vi.fn().mockResolvedValue({
        status: 'running',
        cursor: '1700000000', // Existing cursor (timestamp)
        pageCursor: null,
      })
      sync.postgresClient.tryStartObjectSync = vi.fn().mockResolvedValue(true)
      sync.postgresClient.getLastCursorBeforeRun = vi.fn().mockResolvedValue('1700000000')
      sync.postgresClient.getLastCompletedCursor = vi.fn().mockResolvedValue('1700000000')
      sync.postgresClient.incrementObjectProgress = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.updateObjectCursor = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.updateObjectPageCursor = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.completeObjectSync = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.failObjectSync = vi.fn().mockResolvedValue(undefined)
      sync.postgresClient.upsertManyWithTimestampProtection = vi.fn().mockResolvedValue([])
    })

    it('should pass created filter when supportsCreatedFilter is true and last cursor before run exists', async () => {
      // Call processNext for credit_note
      await sync.processNext('credit_note')

      // Verify that creditNotes.list was called with created filter
      expect(mockCreditNotesList).toHaveBeenCalledTimes(1)
      const callArgs = mockCreditNotesList.mock.calls[0][0]

      // Cursor boundary should come from getLastCursorBeforeRun, not the current run cursor.
      expect(callArgs).toMatchObject({
        limit: 100,
        created: { gte: 1700000000 },
      })
    })

    it('should NOT have starting_after when using created filter and pageCursor is null', async () => {
      await sync.processNext('credit_note')

      const callArgs = mockCreditNotesList.mock.calls[0][0]

      // When NO pageCursor is present, starting_after should NOT be present
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('when doing historical backfill, should not switch into incremental mode early', async () => {
      sync.postgresClient.getObjectRun = vi.fn().mockResolvedValue({
        status: 'running',
        cursor: '1700000500', // Updated cursor value in current run
        pageCursor: 'cn_existing_123',
      })
      // getLastCursorBeforeRun returns the cursor from before this run started
      sync.postgresClient.getLastCursorBeforeRun = vi.fn().mockResolvedValue('1700000000')

      await sync.processNext('credit_note')

      const callArgs = mockCreditNotesList.mock.calls[0][0]

      // should use the pre-run cursor (1700000000), not the updated current run cursor (1700000500) to avoid re-fetching newest-only pages.
      expect(callArgs).toMatchObject({
        limit: 100,
        created: { gte: 1700000000 },
        starting_after: 'cn_existing_123',
      })
    })

    it('during historical backfill should remember where it left off so the next run can continue paging older data', async () => {
      mockCreditNotesList.mockResolvedValue({
        data: [
          { id: 'cn_1', created: 1700000100 },
          { id: 'cn_2', created: 1700000200 },
        ],
        has_more: true,
      })

      await sync.processNext('credit_note')

      // Should update page_cursor with 'cn_2' (the last ID in the page)
      expect(sync.postgresClient.updateObjectPageCursor).toHaveBeenCalledWith(
        'acct_test',
        expect.any(Date),
        'credit_notes',
        'cn_2'
      )
    })

    it('if Stripe API returns has_more but empty array, stop the backfill to avoid a forever loop', async () => {
      mockCreditNotesList.mockResolvedValue({
        data: [],
        has_more: true,
      })

      const result = await sync.processNext('credit_note')

      expect(result).toMatchObject({ processed: 0, hasMore: false })
      expect(sync.postgresClient.failObjectSync).toHaveBeenCalledWith(
        'acct_test',
        expect.any(Date),
        'credit_notes',
        expect.stringContaining('has_more=true with empty page')
      )
      expect(sync.postgresClient.updateObjectPageCursor).not.toHaveBeenCalled()
    })

    it('should update cursor with max created timestamp from response', async () => {
      await sync.processNext('credit_note')

      // Should update cursor with max created (1700000200)
      // The key assertion is that the cursor value is the MAX timestamp from the response
      expect(sync.postgresClient.updateObjectCursor).toHaveBeenCalled()
      const updateCursorCall = vi.mocked(sync.postgresClient.updateObjectCursor).mock.calls[0]
      expect(updateCursorCall[0]).toBe('acct_test') // accountId
      expect(updateCursorCall[2]).toBe('credit_notes') // resourceName
      expect(updateCursorCall[3]).toBe('1700000200') // cursor = max(created) from response
    })

    it('after historical backfill completes, the next sync run should switch into incremental mode', async () => {
      const runA = new Date('2024-01-01T00:00:00.000Z')
      const runB = new Date('2024-01-02T00:00:00.000Z')

      // Force run selection: first 2 calls are two ticks within runA, then a later tick starts runB.
      sync.postgresClient.getOrCreateSyncRun = vi
        .fn()
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runA, isNew: true })
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runA, isNew: false })
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runB, isNew: true })

      // Cursor from BEFORE a run starts:
      // - runA: none
      // - runB: exists
      sync.postgresClient.getLastCursorBeforeRun = vi
        .fn()
        .mockImplementation((_acct, _obj, runStartedAt) => {
          if (runStartedAt instanceof Date && runStartedAt.getTime() === runB.getTime()) {
            return Promise.resolve('1700000200')
          }
          return Promise.resolve(null)
        })

      // Object run state across calls:
      // 1) runA tick #1: no pageCursor yet
      // 2) runA tick #2: pageCursor exists from tick #1
      // 3) runB tick #1: new run starts, so no pageCursor
      sync.postgresClient.getObjectRun = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'running',
          cursor: null,
          pageCursor: null,
        })
        .mockResolvedValueOnce({
          status: 'running',
          cursor: '1700000200', // should NOT affect created filter in this run
          pageCursor: 'cn_2',
        })
        .mockResolvedValueOnce({
          status: 'running',
          cursor: null,
          pageCursor: null,
        })

      // Stripe list responses:
      // - runA tick #1: has_more=true (needs another page)
      // - runA tick #2: has_more=false (historical done)
      // - runB tick #1: incremental page
      mockCreditNotesList
        .mockResolvedValueOnce({
          data: [
            { id: 'cn_1', created: 1700000100 },
            { id: 'cn_2', created: 1700000200 },
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cn_3', created: 1699999999 }],
          has_more: false,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cn_4', created: 1700000300 }],
          has_more: false,
        })

      // Run A: tick 1
      await sync.processNext('credit_note')
      // Run A: tick 2
      await sync.processNext('credit_note')
      // Run B: (should now be incremental mode)
      await sync.processNext('credit_note')

      const call1 = mockCreditNotesList.mock.calls[0]![0]
      const call2 = mockCreditNotesList.mock.calls[1]![0]
      const call3 = mockCreditNotesList.mock.calls[2]![0]

      // Run A should NOT apply created filter (historical)
      expect(call1.created).toBeUndefined()
      expect(call1.starting_after).toBeUndefined()
      expect(call2.created).toBeUndefined()
      expect(call2.starting_after).toBe('cn_2')

      // Run B should apply incremental boundary
      expect(call3).toMatchObject({
        limit: 100,
        created: { gte: 1700000200 },
      })
      expect(call3.starting_after).toBeUndefined()
    })

    it('if a backfill run ends early, the next run should keep doing historical backfill (not incremental) until history finishes', async () => {
      // Scenario we care about for edge functions:
      // - runA starts historical backfill but ends before finishing (e.g., timeout/stale cancel).
      // - runB starts later and must still do historical backfill (no created.gte) until it finishes paging history.
      // - only after history finishes should a later run (runC) switch into incremental mode.

      const runA = new Date('2024-01-01T00:00:00.000Z')
      const runB = new Date('2024-01-02T00:00:00.000Z')
      const runC = new Date('2024-01-03T00:00:00.000Z')

      // Force run selection across ticks:
      // 1) tick in runA (historical, incomplete)
      // 2) tick in runB (new run after runA ended early)
      // 3) tick in runB (continues paging and finishes history)
      // 4) tick in runC (incremental)
      sync.postgresClient.getOrCreateSyncRun = vi
        .fn()
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runA, isNew: true })
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runB, isNew: true })
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runB, isNew: false })
        .mockResolvedValueOnce({ accountId: 'acct_test', runStartedAt: runC, isNew: true })

      // Cursor from BEFORE a run starts:
      // - runA/runB: none → historical
      // - runC: exists → incremental
      sync.postgresClient.getLastCursorBeforeRun = vi
        .fn()
        .mockImplementation((_acct, _obj, runStartedAt) => {
          if (runStartedAt instanceof Date && runStartedAt.getTime() === runC.getTime()) {
            return Promise.resolve('1700000200')
          }
          return Promise.resolve(null)
        })

      // Object run state across calls:
      // - runA tick #1: no pageCursor yet
      // - runB tick #1: new run starts, no pageCursor
      // - runB tick #2: continue with pageCursor from tick #1
      // - runC tick #1: new run starts, no pageCursor
      sync.postgresClient.getObjectRun = vi
        .fn()
        .mockResolvedValueOnce({ status: 'running', cursor: null, pageCursor: null })
        .mockResolvedValueOnce({ status: 'running', cursor: null, pageCursor: null })
        .mockResolvedValueOnce({
          status: 'running',
          cursor: '1700000200', // should NOT force incremental mid-run
          pageCursor: 'cn_2',
        })
        .mockResolvedValueOnce({ status: 'running', cursor: null, pageCursor: null })

      // Stripe list responses:
      // - runA tick #1: has_more=true (incomplete historical backfill)
      // - runB tick #1: has_more=true (historical continues)
      // - runB tick #2: has_more=false (historical finished)
      // - runC tick #1: incremental
      mockCreditNotesList
        .mockResolvedValueOnce({
          data: [
            { id: 'cn_1', created: 1700000100 },
            { id: 'cn_2', created: 1700000200 },
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [
            { id: 'cn_1', created: 1700000100 },
            { id: 'cn_2', created: 1700000200 },
          ],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cn_3', created: 1699999999 }],
          has_more: false,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cn_4', created: 1700000300 }],
          has_more: false,
        })

      await sync.processNext('credit_note') // runA tick #1
      await sync.processNext('credit_note') // runB tick #1
      await sync.processNext('credit_note') // runB tick #2 (finishes)
      await sync.processNext('credit_note') // runC tick #1 (incremental)

      const call1 = mockCreditNotesList.mock.calls[0]![0]
      const call2 = mockCreditNotesList.mock.calls[1]![0]
      const call3 = mockCreditNotesList.mock.calls[2]![0]
      const call4 = mockCreditNotesList.mock.calls[3]![0]

      // runA: historical
      expect(call1.created).toBeUndefined()
      expect(call1.starting_after).toBeUndefined()

      // runB: still historical (NOT incremental)
      expect(call2.created).toBeUndefined()
      expect(call2.starting_after).toBeUndefined()
      expect(call3.created).toBeUndefined()
      expect(call3.starting_after).toBe('cn_2')

      // runC: incremental
      expect(call4).toMatchObject({
        limit: 100,
        created: { gte: 1700000200 },
      })
      expect(call4.starting_after).toBeUndefined()
    })
  })
})
