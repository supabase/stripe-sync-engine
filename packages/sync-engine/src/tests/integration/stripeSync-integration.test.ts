import { describe, it, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest'
import {
  setupTestDatabase,
  createTestStripeSync,
  upsertTestAccount,
  resetMockCounters,
  createMockCustomerBatch,
  createMockCouponBatch,
  createPaginatedResponse,
  DatabaseValidator,
  type MockStripeObject,
  type TestDatabase,
} from '../testSetup'
import type { StripeSync } from '../../index'

const TEST_ACCOUNT_ID = 'acct_test_integration'

describe('StripeSync Integration Tests', () => {
  let sync: StripeSync
  let db: TestDatabase
  let validator: DatabaseValidator
  let mockCustomers: MockStripeObject[] = []
  let mockCoupons: MockStripeObject[] = []

  beforeAll(async () => {
    db = await setupTestDatabase()
    validator = new DatabaseValidator(db.databaseUrl)
  })

  afterAll(async () => {
    if (validator) await validator.close()
    if (sync) await sync.postgresClient.pool.end()
    if (db) await db.close()
  })

  beforeEach(async () => {
    if (sync) await sync.postgresClient.pool.end()

    resetMockCounters()
    mockCustomers = []
    mockCoupons = []

    await validator.clearAccountData(TEST_ACCOUNT_ID, [
      'stripe.customers',
      'stripe.plans',
      'stripe.coupons',
    ])

    sync = await createTestStripeSync({
      databaseUrl: db.databaseUrl,
      accountId: TEST_ACCOUNT_ID,
    })

    await upsertTestAccount(sync, TEST_ACCOUNT_ID)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync.stripe as any).customers = {
      list: vi
        .fn()
        .mockImplementation((params) =>
          Promise.resolve(createPaginatedResponse(mockCustomers, params))
        ),
      retrieve: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(mockCustomers.find((c) => c.id === id) ?? null)
        ),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync.stripe as any).coupons = {
      list: vi
        .fn()
        .mockImplementation((params) =>
          Promise.resolve(createPaginatedResponse(mockCoupons, params))
        ),
      retrieve: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(mockCoupons.find((c) => c.id === id) ?? null)
        ),
    }
  })

  it('should have validator connected to database', async () => {
    const customerCount = await validator.getRowCount('stripe.customers', TEST_ACCOUNT_ID)
    expect(customerCount).toBe(0)
  })

  describe('fullSync', () => {
    it('should sync all customers via fullSync', async () => {
      mockCustomers = createMockCustomerBatch(350)

      const result = await sync.fullSync(['customer'], true, 1, 50, false)

      expect(result.totalSynced).toStrictEqual(350)

      const countInDb = await validator.getRowCount('stripe.customers', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(350)

      const customersInDb = await validator.getColumnValues(
        'stripe.customers',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id))
    })

    it('should sync new records for incremental consistency', async () => {
      await sync.fullSync(['customer'], true, 2, 50, false)

      mockCustomers = createMockCustomerBatch(100)

      const result = await sync.fullSync(['customer'], true, 2, 50, false, 0)

      expect(result.totalSynced).toStrictEqual(100)

      const countInDb = await validator.getRowCount('stripe.customers', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(100)

      const customersInDb = await validator.getColumnValues(
        'stripe.customers',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id))
    })

    it('should backfill historical records and then pick up new records on next sync', async () => {
      const historicalStartTimestamp = Math.floor(Date.now() / 1000) - 10000
      const historicalCustomers = createMockCustomerBatch(200, historicalStartTimestamp)
      mockCustomers = historicalCustomers

      const result = await sync.fullSync(['customer'], true, 2, 50, false, 0)
      expect(result.totalSynced).toStrictEqual(200)

      let countInDb = await validator.getRowCount('stripe.customers', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(200)

      const newStartTimestamp = Math.floor(Date.now() / 1000)
      const newCustomers = createMockCustomerBatch(5, newStartTimestamp)
      mockCustomers = [...newCustomers, ...mockCustomers]

      const customersAfterBackfill = await validator.getColumnValues(
        'stripe.customers',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(customersAfterBackfill).toStrictEqual(historicalCustomers.map((c) => c.id))

      await sync.fullSync(['customer'], true, 2, 50, false, 0)

      countInDb = await validator.getRowCount('stripe.customers', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(205)

      const customersAfterIncremental = await validator.getColumnValues(
        'stripe.customers',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(customersAfterIncremental).toStrictEqual(
        [...historicalCustomers, ...newCustomers].map((c) => c.id)
      )
    })
  })

  describe('coupon fullSync', () => {
    it('should sync all coupons via fullSync', async () => {
      mockCoupons = createMockCouponBatch(150)

      const result = await sync.fullSync(['coupon'], true, 1, 50, false)

      expect(result.totalSynced).toStrictEqual(150)

      const countInDb = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(150)

      const couponsInDb = await validator.getColumnValues('stripe.coupons', 'id', TEST_ACCOUNT_ID)
      expect(couponsInDb).toStrictEqual(mockCoupons.map((c) => c.id))
    })

    it('should sync new coupons for incremental consistency', async () => {
      await sync.fullSync(['coupon'], true, 2, 50, false)

      mockCoupons = createMockCouponBatch(50)

      const result = await sync.fullSync(['coupon'], true, 2, 50, false, 0)

      expect(result.totalSynced).toStrictEqual(50)

      const countInDb = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(50)

      const couponsInDb = await validator.getColumnValues('stripe.coupons', 'id', TEST_ACCOUNT_ID)
      expect(couponsInDb).toStrictEqual(mockCoupons.map((c) => c.id))
    })

    it('should backfill historical coupons and then pick up new coupons on next sync', async () => {
      const historicalStartTimestamp = Math.floor(Date.now() / 1000) - 10000
      const historicalCoupons = createMockCouponBatch(100, historicalStartTimestamp)
      mockCoupons = historicalCoupons

      const result = await sync.fullSync(['coupon'], true, 2, 50, false, 0)
      expect(result.totalSynced).toStrictEqual(100)

      let countInDb = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(100)

      const newStartTimestamp = Math.floor(Date.now() / 1000)
      const newCoupons = createMockCouponBatch(3, newStartTimestamp)
      mockCoupons = [...newCoupons, ...mockCoupons]

      const couponsAfterBackfill = await validator.getColumnValues(
        'stripe.coupons',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(couponsAfterBackfill).toStrictEqual(historicalCoupons.map((c) => c.id))

      await sync.fullSync(['coupon'], true, 2, 50, false, 0)

      countInDb = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(103)

      const couponsAfterIncremental = await validator.getColumnValues(
        'stripe.coupons',
        'id',
        TEST_ACCOUNT_ID
      )
      expect(couponsAfterIncremental).toStrictEqual(
        [...historicalCoupons, ...newCoupons].map((c) => c.id)
      )
    })

    it('should handle deleted coupons during sync', async () => {
      mockCoupons = createMockCouponBatch(10)

      await sync.fullSync(['coupon'], true, 1, 50, false)

      const countInDb = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(10)

      mockCoupons = mockCoupons.map((c, i) => (i < 3 ? { ...c, deleted: true } : c))

      await sync.fullSync(['coupon'], true, 1, 50, false, 0)

      const finalCount = await validator.getRowCount('stripe.coupons', TEST_ACCOUNT_ID)
      expect(finalCount).toStrictEqual(10)
    })
  })
})
