import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSyncWorker } from '../../stripeSyncWorker'
import { createMockedStripeSync } from '../testSetup'
import type { ResourceConfig } from '../../types'

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
    it('should have supportsCreatedFilter: true for credit_note', async () => {
      const sync = await createMockedStripeSync()
      const registry = sync.resourceRegistry

      expect(registry.credit_note.supportsCreatedFilter).toBe(true)
    })

    it('should have supportsCreatedFilter: true for all core Stripe objects except payment_method and tax_id', async () => {
      const sync = await createMockedStripeSync()
      const registry = sync.resourceRegistry

      const coreObjectsExpectedFalse = ['payment_method', 'tax_id']

      for (const [objectName, config] of Object.entries(registry)) {
        const resourceConfig = config as { supportsCreatedFilter: boolean }

        if (coreObjectsExpectedFalse.includes(objectName)) {
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

  describe('StripeSyncWorker.fetchOnePage pagination behavior', () => {
    let mockCreditNotesList: ReturnType<typeof vi.fn>
    let creditNotesConfig: ResourceConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockPostgres = { waitForRateLimit: vi.fn().mockResolvedValue(undefined) } as any

    beforeEach(async () => {
      mockCreditNotesList = vi.fn().mockResolvedValue({
        data: [
          { id: 'cn_1', created: 1700000100 },
          { id: 'cn_2', created: 1700000200 },
        ],
        has_more: false,
      })

      creditNotesConfig = {
        tableName: 'credit_notes',
        order: 0,
        supportsCreatedFilter: true,
        supportsLimit: true,
        listFn: mockCreditNotesList,
      } as unknown as ResourceConfig
    })

    it('should pass created filter when supportsCreatedFilter is true and cursor exists', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        mockPostgres,
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() },
        vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
      )

      await worker.fetchOnePage('credit_notes', '1700000000', null, creditNotesConfig)

      expect(mockCreditNotesList).toHaveBeenCalledTimes(1)
      const callArgs = mockCreditNotesList.mock.calls[0][0]

      expect(callArgs).toMatchObject({
        limit: 100,
        created: { lte: 1700000000 },
      })
    })

    it('should NOT have starting_after when pageCursor is null', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        mockPostgres,
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() },
        vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
      )

      await worker.fetchOnePage('credit_notes', '1700000000', null, creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('should include starting_after when pageCursor is provided', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        mockPostgres,
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() },
        vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
      )

      await worker.fetchOnePage('credit_notes', '1700000000', 'cn_existing_123', creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs).toMatchObject({
        limit: 100,
        created: { lte: 1700000000 },
        starting_after: 'cn_existing_123',
      })
    })

    it('should NOT pass created filter when cursor is null (historical backfill)', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        mockPostgres,
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() },
        vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
      )

      await worker.fetchOnePage('credit_notes', null, null, creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.created).toBeUndefined()
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('should NOT pass created filter when supportsCreatedFilter is false', async () => {
      const noCreatedFilterConfig = {
        ...creditNotesConfig,
        supportsCreatedFilter: false as const,
      }

      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        mockPostgres,
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() },
        vi.fn() as any // eslint-disable-line @typescript-eslint/no-explicit-any
      )

      await worker.fetchOnePage(
        'credit_notes',
        '1700000000',
        null,
        noCreatedFilterConfig,
        null,
        null
      )

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.created).toBeUndefined()
    })
  })
})
