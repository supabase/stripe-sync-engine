import { runMigrations } from '@stripe/destination-postgres'
import { createWebhookService, type WebhookService } from '../webhookService'
import { vitest, beforeAll, describe, test, expect, afterAll } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'
import Stripe from 'stripe'
import { ensureTestMerchantConfig } from './helpers/merchantConfig'

let stripeSync: WebhookService | undefined
const customerId = 'cus_111'

ensureTestMerchantConfig()

beforeAll(async () => {
  process.env.REVALIDATE_ENTITY_VIA_STRIPE_API = 'false'
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
    stripeAccountId: 'acct_test_account',
    revalidateObjectsViaStripeApi: config.revalidateObjectsViaStripeApi,
    ...(config.partnerId ? { partnerId: config.partnerId } : {}),
    logger,
    poolConfig: {
      connectionString: primaryMerchantConfig.databaseUrl,
    },
  })
  Object.assign(stripeSync.stripe, mockStripe)
})

afterAll(async () => {
  if (stripeSync) {
    await Promise.all([
      stripeSync.query(`delete from stripe.active_entitlements where customer = '${customerId}'`),
      stripeSync.query(`delete from stripe.customers where id = '${customerId}'`),
    ])
  }
})

describe('entitlements', () => {
  test('should sync active entitlements for a customer', async () => {
    const accountId = await stripeSync.getAccountId()
    const customer = [
      {
        id: customerId,
        object: 'customer',
        livemode: false,
        name: 'Test Customer 1',
      } as Stripe.Customer,
    ]
    await stripeSync.upsertAny(customer, accountId)

    const activeEntitlements = [
      {
        id: 'ent_test_111',
        object: 'entitlements.active_entitlement' as const,
        feature: 'feat_test_111',
        livemode: false,
        lookup_key: 'feature_2',
        last_synced_at: new Date(),
      },
    ]

    await stripeSync.writer.deleteRemovedActiveEntitlements(
      customerId,
      activeEntitlements.map((entitlement) => entitlement.id)
    )
    await stripeSync.upsertActiveEntitlements(customerId, activeEntitlements, accountId, false)

    const entitlements = await stripeSync.query(
      `select * from stripe.active_entitlements where customer = '${customerId}'`
    )

    expect(entitlements.rows).toEqual([
      {
        id: activeEntitlements[0].id,
        object: activeEntitlements[0].object,
        feature: activeEntitlements[0].feature,
        livemode: activeEntitlements[0].livemode,
        lookup_key: activeEntitlements[0].lookup_key,
        customer: customerId,
        _account_id: accountId,
        _raw_data: expect.objectContaining({
          id: activeEntitlements[0].id,
          feature: activeEntitlements[0].feature,
        }),
        _updated_at: expect.any(Date),
        _last_synced_at: expect.any(Date),
      },
    ])

    const newActiveEntitlements = [
      {
        id: 'ent_test_222',
        object: 'entitlements.active_entitlement' as const,
        feature: 'feat_test_222',
        livemode: false,
        lookup_key: 'feature_3',
        last_synced_at: new Date(),
      },
      {
        id: 'ent_test_333',
        object: 'entitlements.active_entitlement' as const,
        feature: 'feat_test_333',
        livemode: false,
        lookup_key: 'feature_4',
        last_synced_at: new Date(),
      },
    ]

    await stripeSync.writer.deleteRemovedActiveEntitlements(
      customerId,
      newActiveEntitlements.map((entitlement) => entitlement.id)
    )

    await stripeSync.upsertActiveEntitlements(customerId, newActiveEntitlements, accountId, false)

    const updatedEntitlements = await stripeSync.query(
      `select * from stripe.active_entitlements where customer = '${customerId}'`
    )

    expect(updatedEntitlements.rows).toEqual(
      newActiveEntitlements.map((entitlement) => ({
        id: entitlement.id,
        object: entitlement.object,
        feature: entitlement.feature,
        livemode: entitlement.livemode,
        lookup_key: entitlement.lookup_key,
        customer: customerId,
        _account_id: accountId,
        _raw_data: expect.objectContaining({
          id: entitlement.id,
          feature: entitlement.feature,
        }),
        _updated_at: expect.any(Date),
        _last_synced_at: expect.any(Date),
      }))
    )
  })
})
