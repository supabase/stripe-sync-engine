import { StripeSync } from '@supabase/stripe-sync-engine'
import { vitest, beforeAll, describe, test, expect, afterAll } from 'vitest'
import { runMigrations } from '@supabase/stripe-sync-engine'
import { getConfig } from '../utils/config.js'
import { mockStripe } from './helpers/mockStripe.js'
import { logger } from '../logger.js'
import Stripe from 'stripe'

let stripeSync: StripeSync
const customerId = 'cus_111'

beforeAll(async () => {
  process.env.REVALIDATE_ENTITY_VIA_STRIPE_API = 'false'
  process.env.BACKFILL_RELATED_ENTITIES = 'false'

  const config = getConfig()
  await runMigrations({
    databaseUrl: config.databaseUrl,
    schema: config.schema,
    logger,
  })

  stripeSync = new StripeSync(config)
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)
})

afterAll(async () => {
  await Promise.all([
    stripeSync.postgresClient.query(
      `delete from stripe.active_entitlements where customer = '${customerId}'`
    ),
    stripeSync.postgresClient.query(`delete from stripe.customers where id = '${customerId}'`),
  ])
})

describe('entitlements', () => {
  test('should sync active entitlements for a customer', async () => {
    const customer = [
      {
        id: customerId,
        object: 'customer',
        livemode: false,
        name: 'Test Customer 1',
      } as Stripe.Customer,
    ]
    await stripeSync.upsertCustomers(customer)

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

    await stripeSync.deleteRemovedActiveEntitlements(
      customerId,
      activeEntitlements.map((entitlement) => entitlement.id)
    )
    await stripeSync.upsertActiveEntitlements(customerId, activeEntitlements, false)

    const entitlements = await stripeSync.postgresClient.query(
      `select * from stripe.active_entitlements where customer = '${customerId}'`
    )

    expect(entitlements.rows).toEqual([
      {
        ...activeEntitlements[0],
        customer: customerId,
        updated_at: expect.any(Date),
        last_synced_at: expect.any(Date),
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

    await stripeSync.deleteRemovedActiveEntitlements(
      customerId,
      newActiveEntitlements.map((entitlement) => entitlement.id)
    )

    await stripeSync.upsertActiveEntitlements(customerId, newActiveEntitlements, false)

    const updatedEntitlements = await stripeSync.postgresClient.query(
      `select * from stripe.active_entitlements where customer = '${customerId}'`
    )

    expect(updatedEntitlements.rows).toEqual(
      newActiveEntitlements.map((entitlement) => ({
        ...entitlement,
        customer: customerId,
        updated_at: expect.any(Date),
        last_synced_at: expect.any(Date),
      }))
    )
  })
})
