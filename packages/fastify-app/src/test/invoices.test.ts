import type Stripe from 'stripe'
import { StripeSync, runMigrations, hashApiKey } from 'stripe-replit-sync'
import { vitest, beforeAll, describe, test, expect } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'

let stripeSync: StripeSync
const TEST_ACCOUNT_ID = 'acct_test'

beforeAll(async () => {
  process.env.AUTO_EXPAND_LISTS = 'true'
  process.env.BACKFILL_RELATED_ENTITIES = 'false'

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
  })
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)

  // Mock getCurrentAccount to avoid API calls
  vitest.spyOn(stripeSync, 'getCurrentAccount').mockResolvedValue({
    id: TEST_ACCOUNT_ID,
    object: 'account',
  } as Stripe.Account)

  // Ensure test account exists in database with API key hash
  const apiKeyHash = hashApiKey(config.stripeSecretKey)
  await stripeSync.postgresClient.upsertAccount(
    {
      id: TEST_ACCOUNT_ID,
      raw_data: { id: TEST_ACCOUNT_ID, object: 'account' },
    },
    apiKeyHash
  )
})

describe('invoices', () => {
  test('should not expand line items if exhaustive', async () => {
    const invoices = [
      {
        id: 'in_xyz',
        object: 'invoice',
        auto_advance: true,
        lines: {
          data: [{ id: 'li_123' }],
          has_more: false,
        },
      } as Stripe.Invoice,
    ]

    await stripeSync.upsertInvoices(invoices, TEST_ACCOUNT_ID, false)

    const lineItems = await stripeSync.postgresClient.query(
      `select lines->'data' as lines from stripe.invoices where id = 'in_xyz' limit 1`
    )
    expect(lineItems.rows[0].lines).toEqual([{ id: 'li_123' }])
  })

  test('should expand line items if not exhaustive', async () => {
    const invoices = [
      {
        id: 'in_xyz2',
        object: 'invoice',
        auto_advance: true,
        lines: {
          data: [{ id: 'li_123' }],
          has_more: true,
        },
      } as Stripe.Invoice,
    ]

    await stripeSync.upsertInvoices(invoices, TEST_ACCOUNT_ID, false)

    const lineItems = await stripeSync.postgresClient.query(
      `select lines->'data' as lines from stripe.invoices where id = 'in_xyz2' limit 1`
    )
    expect(lineItems.rows[0].lines).toEqual([{ id: 'li_123' }, { id: 'li_1234' }])
  })
})
