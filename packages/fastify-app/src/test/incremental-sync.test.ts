import type Stripe from 'stripe'
import { StripeSync, runMigrations, hashApiKey } from 'stripe-replit-sync'
import { vitest, beforeAll, afterAll, describe, test, expect, beforeEach } from 'vitest'
import { getConfig } from '../utils/config'
import { logger } from '../logger'

let stripeSync: StripeSync
const testAccountId = 'acct_test_account'

beforeAll(async () => {
  const config = getConfig()
  await runMigrations({
    databaseUrl: config.databaseUrl,
    schema: config.schema,
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
    await stripeSync.postgresClient.pool.query('DELETE FROM stripe.products WHERE _id LIKE $1', [
      'test_prod_%',
    ])
    await stripeSync.postgresClient.pool.query(
      'DELETE FROM stripe._sync_status WHERE resource LIKE $1 OR resource = $2',
      ['test_%', 'products']
    )
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

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    // First sync - no cursor, should fetch all
    await stripeSync.syncProducts()

    expect(stripeSync.stripe.products.list).toHaveBeenCalledWith({ limit: 100 })

    // Verify products were inserted
    const firstResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.products WHERE _id LIKE $1',
      ['test_prod_%']
    )
    expect(parseInt(firstResult.rows[0].count)).toBe(3)

    // Verify cursor was saved
    const cursor = await stripeSync.postgresClient.getSyncCursor('products', testAccountId)
    expect(cursor).toBe(1705075200) // Max created from first sync

    // Mock Stripe API for second sync - only returns new products
    const mockListIncremental = vitest.fn(async function* () {
      for (const product of newProducts) {
        yield product
      }
    })

    vitest
      .spyOn(stripeSync.stripe.products, 'list')
      .mockReturnValue(mockListIncremental() as unknown)

    // Second sync - should use cursor
    await stripeSync.syncProducts()

    expect(stripeSync.stripe.products.list).toHaveBeenLastCalledWith({
      limit: 100,
      created: { gte: 1705075200 },
    })

    // Verify new product was inserted
    const secondResult = await stripeSync.postgresClient.pool.query(
      'SELECT COUNT(*) FROM stripe.products WHERE _id LIKE $1',
      ['test_prod_%']
    )
    expect(parseInt(secondResult.rows[0].count)).toBe(4)

    // Verify cursor was updated
    const newCursor = await stripeSync.postgresClient.getSyncCursor('products', testAccountId)
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

    // Spy on updateSyncCursor
    const updateSpy = vitest.spyOn(stripeSync.postgresClient, 'updateSyncCursor')

    await stripeSync.syncProducts()

    // Should update cursor 3 times: after 100, after 200, after 250
    expect(updateSpy).toHaveBeenCalledTimes(3)
    expect(updateSpy).toHaveBeenNthCalledWith(1, 'products', testAccountId, 1704902400 + 99)
    expect(updateSpy).toHaveBeenNthCalledWith(2, 'products', testAccountId, 1704902400 + 199)
    expect(updateSpy).toHaveBeenNthCalledWith(3, 'products', testAccountId, 1704902400 + 249)

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

    const initialCursor = await stripeSync.postgresClient.getSyncCursor('products', testAccountId)
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

    // Cursor should be unchanged
    const afterCursor = await stripeSync.postgresClient.getSyncCursor('products', testAccountId)
    expect(afterCursor).toBe(initialCursor)
  })

  test('should use explicit filter instead of cursor when provided', async () => {
    // Set up a cursor
    await stripeSync.postgresClient.updateSyncCursor('products', testAccountId, 1704902400)

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

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    // Call with explicit filter (earlier than cursor)
    await stripeSync.syncProducts({
      created: { gte: 1672531200 },
    })

    // Should use explicit filter, not cursor
    expect(stripeSync.stripe.products.list).toHaveBeenCalledWith({
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
    const cursor = await stripeSync.postgresClient.getSyncCursor('products', testAccountId)
    expect(cursor).toBe(1704902400)

    // Status should be error
    const status = await stripeSync.postgresClient.pool.query(
      'SELECT status, error_message FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
      ['products', testAccountId]
    )
    expect(status.rows[0].status).toBe('error')
    expect(status.rows[0].error_message).toContain('Simulated sync error')

    // Second attempt should succeed
    callCount = 0
    await stripeSync.syncProducts()

    // Status should be complete
    const finalStatus = await stripeSync.postgresClient.pool.query(
      'SELECT status FROM stripe._sync_status WHERE resource = $1 AND "account_id" = $2',
      ['products', testAccountId]
    )
    expect(finalStatus.rows[0].status).toBe('complete')
  })

  test('should work with syncBackfill using cursor automatically', async () => {
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

    const mockList = vitest.fn(async function* () {
      for (const product of products) {
        yield product
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockList() as unknown)

    // First backfill
    await stripeSync.syncBackfill({ object: 'product' })

    expect(stripeSync.stripe.products.list).toHaveBeenCalledWith({ limit: 100 })

    // Second backfill should be incremental
    const newProducts: Stripe.Product[] = [
      {
        id: 'test_prod_backfill_3',
        object: 'product',
        created: 1705075200,
        name: 'Product 3',
      } as Stripe.Product,
    ]

    const mockListNew = vitest.fn(async function* () {
      for (const product of newProducts) {
        yield product
      }
    })

    vitest.spyOn(stripeSync.stripe.products, 'list').mockReturnValue(mockListNew() as unknown)

    await stripeSync.syncBackfill({ object: 'product' })

    expect(stripeSync.stripe.products.list).toHaveBeenLastCalledWith({
      limit: 100,
      created: { gte: 1704988800 },
    })
  })
})
