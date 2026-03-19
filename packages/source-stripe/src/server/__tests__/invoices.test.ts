import type Stripe from 'stripe'
import { runMigrations } from '@stripe/destination-postgres'
import { createWebhookService, type WebhookService } from '../webhookService'
import { vitest, beforeAll, describe, test, expect } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'
import { ensureTestMerchantConfig } from './helpers/merchantConfig'

let stripeSync: WebhookService | undefined
const TEST_ACCOUNT_ID = 'acct_test_account'

ensureTestMerchantConfig()

beforeAll(async () => {
  process.env.AUTO_EXPAND_LISTS = 'true'
  process.env.BACKFILL_RELATED_ENTITIES = 'false'

  const config = getConfig()
  const primaryMerchantConfig = Object.values(config.merchantConfigByHost)[0]
  if (!primaryMerchantConfig) {
    throw new Error('MERCHANT_CONFIG_JSON must define at least one merchant')
  }
  await runMigrations({
    databaseUrl: primaryMerchantConfig.databaseUrl,

    logger,
  })

  stripeSync = await createWebhookService({
    stripeSecretKey: primaryMerchantConfig.stripeSecretKey,
    stripeWebhookSecret: primaryMerchantConfig.stripeWebhookSecret,
    databaseUrl: primaryMerchantConfig.databaseUrl,
    stripeApiVersion: config.stripeApiVersion,
    stripeAccountId: TEST_ACCOUNT_ID,
    autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
    backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
    revalidateObjectsViaStripeApi: config.revalidateObjectsViaStripeApi,
    ...(config.partnerId ? { partnerId: config.partnerId } : {}),
    logger,
    poolConfig: {
      connectionString: primaryMerchantConfig.databaseUrl,
    },
  })
  Object.assign(stripeSync.stripe, mockStripe)
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

    await stripeSync.upsertAny(invoices, TEST_ACCOUNT_ID, false)

    const lineItems = await stripeSync.query(
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

    await stripeSync.upsertAny(invoices, TEST_ACCOUNT_ID, false)

    const lineItems = await stripeSync.query(
      `select lines->'data' as lines from stripe.invoices where id = 'in_xyz2' limit 1`
    )
    expect(lineItems.rows[0].lines).toEqual([{ id: 'li_123' }, { id: 'li_1234' }])
  })
})
