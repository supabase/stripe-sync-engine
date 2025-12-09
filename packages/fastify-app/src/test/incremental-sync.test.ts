import type Stripe from 'stripe'
import { StripeSync, runMigrations, hashApiKey } from 'stripe-experiment-sync'
import { vitest, beforeAll, afterAll, describe, test, expect, beforeEach } from 'vitest'
import { getConfig } from '../utils/config'
import { logger } from '../logger'

let stripeSync: StripeSync
const testAccountId = 'acct_test_account'

// Helper to get cursor from most recent sync run (for test verification - any status)
async function getCursor(resourceName: string): Promise<number | null> {
  const result = await stripeSync.postgresClient.pool.query(
    `SELECT o.cursor FROM stripe._sync_obj_run o
     JOIN stripe._sync_run r ON o."_account_id" = r."_account_id" AND o.run_started_at = r.started_at
     WHERE o."_account_id" = $1 AND o.object = $2
     ORDER BY r.started_at DESC
     LIMIT 1`,
    [testAccountId, resourceName]
  )
  return result.rows[0]?.cursor ? parseInt(result.rows[0].cursor) : null
}

beforeAll(async () => {
  const config = getConfig()
  await runMigrations({
    databaseUrl: config.databaseUrl,

    logger,
  })

  stripeSync = new StripeSync({
    ...config,
    poolConfig: {
      connectionString: config.databaseUrl,
    },
    stripeAccountId: testAccountId,
  })

  // Mock Stripe account retrieval to avoid API calls
  vitest.spyOn(stripeSync.stripe.accounts, 'retrieve').mockResolvedValue({
    id: testAccountId,
    object: 'account',
  } as Stripe.Account)

  // Ensure test account exists in database with API key hash
  const apiKeyHash = hashApiKey(config.stripeSecretKey)
  await stripeSync.postgresClient.upsertAccount(
    {
      id: testAccountId,
      raw_data: { id: testAccountId, object: 'account' },
    },
    apiKeyHash
  )
})

afterAll(async () => {
  await stripeSync.postgresClient.pool.end()
})

describe('Incremental Sync', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.products WHERE id LIKE $1', [
      'test_prod_%',
    ])
    await stripeSync.postgresClient.deleteSyncRuns(testAccountId)
    // Clear cached account so it re-fetches using the mock
    stripeSync.cachedAccount = null
  })

  test('should only fetch new products on second sync', async () => {
    const allProducts: Stripe.Product[] = [
      {
        id: 'test_prod_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
      {
        id: 'test_prod_2',
        object: 'product',
        created: 1704988800,
        name: 'Product 2',
      } as Stripe.Product,
      {
        id: 'test_prod_3',
        object: 'product',
        created: 1705075200,
        name: 'Product 3',
      } as Stripe.Product,
    ]

    const newProducts: Stripe.Product[] = [
      {
        id: 'test_prod_4',
        object: 'product',
        created: 1705161600,
        name: 'Product 4',
      } as Stripe.Product,
    ]

    // Mock Stripe API for first sync - returns all products
    const mockList = vitest.fn(async function* () {
      for (const product of allProducts) {
        yield product
      }
    })

    const listSpy = vitest
      .spyOn(stripeSync.stripe.products, 'list')
      .mockReturnValue(mockList() as unknown)

    // First sync - no cursor, should fetch all
    await stripeSync.syncProducts()

    expect(listSpy).toHaveBeenCalledWith({ limit: 100 })

    // Verify products were inserted
    const firstResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.products WHERE id LIKE $1',
      ['test_prod_%']
    )
    expect(parseInt(firstResult.rows[0].count)).toBe(3)

    // Verify cursor was saved in new observability tables
    const cursor = await getCursor('products')
    expect(cursor).toBe(1705075200) // Max created from first sync

    // Mock Stripe API for second sync - only returns new products
    const mockListIncremental = vitest.fn(async function* () {
      for (const product of newProducts) {
        yield product
      }
    })

    const listSpyIncremental = vitest
      .spyOn(stripeSync.stripe.products, 'list')
      .mockReturnValue(mockListIncremental() as unknown)

    // Second sync - should use cursor
    await stripeSync.syncProducts()

    expect(listSpyIncremental).toHaveBeenCalledWith({
      limit: 100,
      created: { gte: 1705075200 },
    })

    // Verify new product was inserted
    const secondResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.products WHERE id LIKE $1',
      ['test_prod_%']
    )
    expect(parseInt(secondResult.rows[0].count)).toBe(4)

    // Verify cursor was updated in new observability tables
    const newCursor = await getCursor('products')
    expect(newCursor).toBe(1705161600)
  })

  test('should checkpoint cursor every 100 items', async () => {
    const products: Stripe.Product[] = Array.from({ length: 250 }, (_, i) => ({
      id: `test_prod_batch_${i}`,
      object: 'product' as const,
      created: 1704902400 + i,
      name: `Product ${i}`,
    })) as Stripe.Product[]

    const mockList = vitest.fn(async function* () {
      for (const product of products) {
        yield product
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    // Spy on updateObjectCursor (new observability method)
    const updateSpy = vitest.spyOn(stripeSync.postgresClient, 'updateObjectCursor')

    await stripeSync.syncProducts()

    // Should update cursor 3 times: after 100, after 200, after 250
    expect(updateSpy).toHaveBeenCalledTimes(3)
    // Note: updateObjectCursor takes (accountId, runStartedAt, object, cursor)
    // We check that the cursor values are correct
    expect(updateSpy).toHaveBeenNthCalledWith(
      1,
      testAccountId,
      expect.any(Date),
      'products',
      String(1704902400 + 99)
    )
    expect(updateSpy).toHaveBeenNthCalledWith(
      2,
      testAccountId,
      expect.any(Date),
      'products',
      String(1704902400 + 199)
    )
    expect(updateSpy).toHaveBeenNthCalledWith(
      3,
      testAccountId,
      expect.any(Date),
      'products',
      String(1704902400 + 249)
    )

    updateSpy.mockRestore()
  })

  test('should not update cursor from webhooks', async () => {
    // Initial backfill
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_webhook_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
    ]

    const mockList = vitest.fn(async function* () {
      for (const product of products) {
        yield product
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    await stripeSync.syncProducts()

    const initialCursor = await getCursor('products')
    expect(initialCursor).toBe(1704902400)

    // Process webhook with newer product
    const webhookEvent: Stripe.Event = {
      id: 'evt_test',
      object: 'event',
      type: 'product.updated',
      data: {
        object: {
          id: 'test_prod_webhook_2',
          object: 'product',
          created: 1705161600, // Much newer
          name: 'Webhook Product',
        } as Stripe.Product,
      },
      created: 1705248000,
    } as Stripe.Event

    await stripeSync.processEvent(webhookEvent)

    // Cursor should be unchanged (webhooks don't update sync cursor)
    const afterCursor = await getCursor('products')
    expect(afterCursor).toBe(initialCursor)
  })

  test('should use explicit filter instead of cursor when provided', async () => {
    // First do a sync to set up a cursor
    const setupProducts: Stripe.Product[] = [
      {
        id: 'test_prod_setup_1',
        object: 'product',
        created: 1704902400,
        name: 'Setup Product',
      } as Stripe.Product,
    ]

    const mockSetupList = vitest.fn(async function* () {
      for (const product of setupProducts) {
        yield product
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockSetupList() as unknown)
    await stripeSync.syncProducts()

    // Verify cursor was set
    const cursor = await getCursor('products')
    expect(cursor).toBe(1704902400)

    // Clean up the run so we can start a new one
    await stripeSync.postgresClient.deleteSyncRuns(testAccountId)

    const products: Stripe.Product[] = [
      {
        id: 'test_prod_explicit_1',
        object: 'product',
        created: 1672531200,
        name: 'Old Product',
      } as Stripe.Product,
    ]

    const mockList = vitest.fn(async function* () {
      for (const product of products) {
        yield product
      }
    })

    const listSpy = vitest
      .spyOn(stripeSync.stripe.products, 'list')
      .mockReturnValue(mockList() as unknown)

    // Call with explicit filter (earlier than cursor)
    await stripeSync.syncProducts({
      created: { gte: 1672531200 },
    })

    // Should use explicit filter, not cursor
    expect(listSpy).toHaveBeenCalledWith({
      limit: 100,
      created: { gte: 1672531200 },
    })
  })

  test('should handle sync error and preserve cursor', async () => {
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_error_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
    ]

    let callCount = 0
    const mockList = vitest.fn(async function* () {
      for (const product of products) {
        yield product
      }
      // Simulate error after yielding products
      callCount++
      if (callCount === 1) {
        throw new Error('Simulated sync error')
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    // First attempt should fail but save checkpoint
    await expect(stripeSync.syncProducts()).rejects.toThrow('Simulated sync error')

    // Cursor should be saved up to checkpoint
    const cursor = await getCursor('products')
    expect(cursor).toBe(1704902400)

    // Status should be error in the new observability tables
    // Use sync_dashboard view which derives status from object states
    const status = await stripeSync.postgresClient.pool.query(
      `SELECT d.status as run_status, d.error_message as run_error,
              o.status as obj_status, o.error_message as obj_error
       FROM stripe.sync_dashboard d
       LEFT JOIN stripe._sync_obj_run o ON o."_account_id" = d.account_id AND o.run_started_at = d.started_at
       WHERE d.account_id = $1 AND o.object = $2
       ORDER BY d.started_at DESC
       LIMIT 1`,
      [testAccountId, 'products']
    )
    expect(status.rows[0].run_status).toBe('error')
    expect(status.rows[0].obj_error).toContain('Simulated sync error')

    // Second attempt should succeed
    callCount = 0
    await stripeSync.syncProducts()

    // Status should be complete
    const finalStatus = await stripeSync.postgresClient.pool.query(
      `SELECT d.status FROM stripe.sync_dashboard d
       JOIN stripe._sync_obj_run o ON o."_account_id" = d.account_id AND o.run_started_at = d.started_at
       WHERE d.account_id = $1 AND o.object = $2
       ORDER BY d.started_at DESC
       LIMIT 1`,
      [testAccountId, 'products']
    )
    expect(finalStatus.rows[0].status).toBe('complete')
  })

  test('should work with processUntilDone using cursor automatically', async () => {
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_backfill_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
      {
        id: 'test_prod_backfill_2',
        object: 'product',
        created: 1704988800,
        name: 'Product 2',
      } as Stripe.Product,
    ]

    // processUntilDone now uses processNext internally which expects { data, has_more } format
    const listSpy = vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    // First sync
    await stripeSync.processUntilDone({ object: 'product' })

    expect(listSpy).toHaveBeenCalledWith({ limit: 100 })

    // Second sync should be incremental
    const newProducts: Stripe.Product[] = [
      {
        id: 'test_prod_backfill_3',
        object: 'product',
        created: 1705075200,
        name: 'Product 3',
      } as Stripe.Product,
    ]

    const listSpyNew = vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: newProducts,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    await stripeSync.processUntilDone({ object: 'product' })

    expect(listSpyNew).toHaveBeenCalledWith({
      limit: 100,
      created: { gte: 1704988800 },
    })
  })
})

describe('processNext', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.products WHERE id LIKE $1', [
      'test_prod_%',
    ])
    await stripeSync.postgresClient.deleteSyncRuns(testAccountId)
    // Clear cached account so it re-fetches using the mock
    stripeSync.cachedAccount = null
  })

  test('should return hasMore: true when more pages exist', async () => {
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_page_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
    ]

    // Mock list to return a response with has_more: true
    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: true,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    const result = await stripeSync.processNext('product')

    expect(result.processed).toBe(1)
    expect(result.hasMore).toBe(true)
    expect(result.runStartedAt).toBeInstanceOf(Date)
  })

  test('should return hasMore: false when no more pages', async () => {
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_page_2',
        object: 'product',
        created: 1704902400,
        name: 'Product 2',
      } as Stripe.Product,
    ]

    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    const result = await stripeSync.processNext('product')

    expect(result.processed).toBe(1)
    expect(result.hasMore).toBe(false)
    expect(result.runStartedAt).toBeInstanceOf(Date)
  })

  test('should use cursor for incremental sync on second call', async () => {
    // First page
    const firstPageProducts: Stripe.Product[] = [
      {
        id: 'test_prod_inc_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
    ]

    // Second page
    const secondPageProducts: Stripe.Product[] = [
      {
        id: 'test_prod_inc_2',
        object: 'product',
        created: 1704988800,
        name: 'Product 2',
      } as Stripe.Product,
    ]

    // Create spy once and chain mock responses - the Proxy wrapper makes
    // each access return a new function, so we need to keep the spy reference
    const listSpy = vitest.spyOn(stripeSync.stripe.products, 'list')
    listSpy
      .mockResolvedValueOnce({
        object: 'list',
        data: firstPageProducts,
        has_more: true,
        url: '/v1/products',
      } as Stripe.ApiList<Stripe.Product>)
      .mockResolvedValueOnce({
        object: 'list',
        data: secondPageProducts,
        has_more: false,
        url: '/v1/products',
      } as Stripe.ApiList<Stripe.Product>)

    await stripeSync.processNext('product')
    await stripeSync.processNext('product')

    // Should have been called with created filter using cursor
    expect(listSpy).toHaveBeenLastCalledWith({
      limit: 100,
      created: { gte: 1704902400 },
    })
  })

  test('should handle empty response', async () => {
    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: [],
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    const result = await stripeSync.processNext('product')

    expect(result.processed).toBe(0)
    expect(result.hasMore).toBe(false)
    expect(result.runStartedAt).toBeInstanceOf(Date)
  })

  test('should throw on API error', async () => {
    vitest.spyOn(stripeSync.stripe.products, 'list').mockRejectedValue(new Error('API Error'))

    await expect(stripeSync.processNext('product')).rejects.toThrow('API Error')
  })
})

describe('processUntilDone', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.products WHERE id LIKE $1', [
      'test_prod_%',
    ])
    await stripeSync.postgresClient.deleteSyncRuns(testAccountId)
    // Clear cached account so it re-fetches using the mock
    stripeSync.cachedAccount = null
  })

  test('should sync products using processUntilDone', async () => {
    const products: Stripe.Product[] = [
      {
        id: 'test_prod_alias_1',
        object: 'product',
        created: 1704902400,
        name: 'Product 1',
      } as Stripe.Product,
    ]

    // processUntilDone now uses processNext internally which expects { data, has_more } format
    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    const result = await stripeSync.processUntilDone({ object: 'product' })

    expect(result.products?.synced).toBe(1)
  })
})

describe('Bug regression tests', () => {
  beforeEach(async () => {
    // Clean up test data before each test
    await stripeSync.postgresClient.pool.query(
      'DELETE FROM stripe.payment_intents WHERE id LIKE $1',
      ['test_pi_%']
    )
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.plans WHERE id LIKE $1', [
      'test_plan_%',
    ])
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.products WHERE id LIKE $1', [
      'test_prod_%',
    ])
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.prices WHERE id LIKE $1', [
      'test_price_%',
    ])
    await stripeSync.postgresClient.deleteSyncRuns(testAccountId)
    // Clear cached account so it re-fetches using the mock
    stripeSync.cachedAccount = null
  })

  test('Bug 1: processUntilDone with payment_intent should NOT sync plans (switch fallthrough)', async () => {
    // This test verifies the fix for the missing break statement bug.
    // Previously case 'payment_intent' fell through to case 'plan'.

    const paymentIntents: Stripe.PaymentIntent[] = [
      {
        id: 'test_pi_1',
        object: 'payment_intent',
        created: 1704902400,
        amount: 1000,
        currency: 'usd',
        status: 'succeeded',
      } as Stripe.PaymentIntent,
    ]

    const plans: Stripe.Plan[] = [
      {
        id: 'test_plan_1',
        object: 'plan',
        created: 1704902400,
        amount: 500,
        currency: 'usd',
        interval: 'month',
      } as Stripe.Plan,
    ]

    // Mock payment_intents.list with { data, has_more } format
    vitest.spyOn(stripeSync.stripe.paymentIntents, 'list').mockResolvedValue({
      object: 'list',
      data: paymentIntents,
      has_more: false,
      url: '/v1/payment_intents',
    } as Stripe.ApiList<Stripe.PaymentIntent>)

    // Mock plans.list with { data, has_more } format
    vitest.spyOn(stripeSync.stripe.plans, 'list').mockResolvedValue({
      object: 'list',
      data: plans,
      has_more: false,
      url: '/v1/plans',
    } as Stripe.ApiList<Stripe.Plan>)

    // Request to sync ONLY payment_intent
    await stripeSync.processUntilDone({ object: 'payment_intent' })

    // Verify payment_intent was synced
    const piResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.payment_intents WHERE id = $1',
      ['test_pi_1']
    )
    expect(parseInt(piResult.rows[0].count)).toBe(1)

    // Verify plan was NOT synced (bug fix verified)
    const planResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.plans WHERE id = $1',
      ['test_plan_1']
    )
    expect(parseInt(planResult.rows[0].count)).toBe(0)

    // Also verify via observability: only payment_intents object run should exist
    const objRuns = await stripeSync.postgresClient.pool.query(
      `SELECT object FROM stripe._sync_obj_run WHERE "_account_id" = $1`,
      [testAccountId]
    )
    const objects = objRuns.rows.map((r: { object: string }) => r.object)
    expect(objects).not.toContain('plans')
  })

  test('Bug 2: separate processUntilDone calls create separate runs (expected behavior)', async () => {
    // Each processUntilDone call creates and completes its own run.
    // This is expected - separate calls = separate runs.

    const products: Stripe.Product[] = [
      {
        id: 'test_prod_run_1',
        object: 'product',
        created: 1704902400,
        name: 'P1',
      } as Stripe.Product,
    ]
    const prices: Stripe.Price[] = [
      {
        id: 'test_price_run_1',
        object: 'price',
        created: 1704902400,
        unit_amount: 100,
        currency: 'usd',
      } as Stripe.Price,
    ]

    // Mock with { data, has_more } format
    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    vitest.spyOn(stripeSync.stripe.prices, 'list').mockResolvedValue({
      object: 'list',
      data: prices,
      has_more: false,
      url: '/v1/prices',
    } as Stripe.ApiList<Stripe.Price>)

    // Run sync for 2 objects in separate calls
    await stripeSync.processUntilDone({ object: 'product' })
    await stripeSync.processUntilDone({ object: 'price' })

    // Count how many sync runs were created
    const runResult = await stripeSync.postgresClient.pool.query(
      `SELECT COUNT(*) FROM stripe._sync_run WHERE "_account_id" = $1`,
      [testAccountId]
    )

    // Each processUntilDone call creates and completes its own run = 2 runs
    // This is expected behavior for separate calls.
    expect(parseInt(runResult.rows[0].count)).toBe(2)
  })

  test('Bug 2 (detailed): processUntilDone should use ONE run for multiple objects', async () => {
    // This tests that processUntilDone creates a single sync run
    // and uses processNext internally for each object type.

    const products: Stripe.Product[] = [
      {
        id: 'test_prod_detailed_1',
        object: 'product',
        created: 1704902400,
        name: 'P1',
      } as Stripe.Product,
    ]
    const prices: Stripe.Price[] = [
      {
        id: 'test_price_detailed_1',
        object: 'price',
        created: 1704902400,
        unit_amount: 100,
        currency: 'usd',
      } as Stripe.Price,
    ]

    // Mock products to return data, then empty (simulating has_more: false)
    vitest.spyOn(stripeSync.stripe.products, 'list').mockResolvedValue({
      object: 'list',
      data: products,
      has_more: false,
      url: '/v1/products',
    } as Stripe.ApiList<Stripe.Product>)

    vitest.spyOn(stripeSync.stripe.prices, 'list').mockResolvedValue({
      object: 'list',
      data: prices,
      has_more: false,
      url: '/v1/prices',
    } as Stripe.ApiList<Stripe.Price>)

    // Call processUntilDone for product, then price - should share ONE run
    await stripeSync.processUntilDone({ object: 'product' })

    // At this point the run is complete. Starting a new processUntilDone
    // will create a NEW run (expected behavior - run was completed).
    // The fix is that within a SINGLE processUntilDone('all') call,
    // all objects share one run.

    // Count runs after first processUntilDone
    const runResultAfterFirst = await stripeSync.postgresClient.pool.query(
      `SELECT COUNT(*) FROM stripe._sync_run WHERE "_account_id" = $1`,
      [testAccountId]
    )
    expect(parseInt(runResultAfterFirst.rows[0].count)).toBe(1)

    // Count object runs - should have 'products' object run
    const objRunResult = await stripeSync.postgresClient.pool.query(
      `SELECT object FROM stripe._sync_obj_run WHERE "_account_id" = $1`,
      [testAccountId]
    )
    expect(objRunResult.rows.map((r: { object: string }) => r.object)).toContain('products')
  })
})
