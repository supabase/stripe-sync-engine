import type Stripe from 'stripe'
import { StripeSync, runMigrations } from '@supabase/stripe-sync-engine'
import { afterAll, afterEach, beforeAll, describe, expect, test, vitest } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'

let stripeSync: StripeSync
let schema: string

beforeAll(async () => {
  process.env.REVALIDATE_OBJECTS_VIA_STRIPE_API = ''
  process.env.BACKFILL_RELATED_ENTITIES = 'false'

  const config = getConfig()
  schema = config.schema

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
})

afterEach(() => {
  vitest.clearAllMocks()
})

afterAll(async () => {
  if (stripeSync) {
    await stripeSync.close()
  }
})

describe('subscription tie-break on same timestamp', () => {
  test('refetches subscription when same-second event would otherwise be skipped', async () => {
    const baseEvent = await import('./stripe/subscription_created.json').then(
      ({ default: data }) => data
    )
    const sameTimestamp = Math.floor(Date.now() / 1000)
    const subscriptionId = baseEvent.data.object.id

    await stripeSync.postgresClient.query(
      `delete from "${schema}"."subscription_items" where subscription = $1`,
      [subscriptionId]
    )
    await stripeSync.postgresClient.query(`delete from "${schema}"."subscriptions" where id = $1`, [
      subscriptionId,
    ])

    const trialEvent = structuredClone(baseEvent)
    trialEvent.id = 'evt_tie_trial'
    trialEvent.type = 'customer.subscription.trial_will_end'
    trialEvent.created = sameTimestamp
    trialEvent.data.object.status = 'trialing'
    trialEvent.data.object.billing_cycle_anchor = 100

    const updatedEvent = structuredClone(baseEvent)
    updatedEvent.id = 'evt_tie_updated'
    updatedEvent.type = 'customer.subscription.updated'
    updatedEvent.created = sameTimestamp
    updatedEvent.data.object.status = 'active'
    updatedEvent.data.object.billing_cycle_anchor = 200

    mockStripe.subscriptions.retrieve.mockResolvedValueOnce({
      ...updatedEvent.data.object,
      billing_cycle_anchor: 300,
      status: 'active',
    })

    await stripeSync.processEvent(trialEvent as Stripe.Event)
    await stripeSync.processEvent(updatedEvent as Stripe.Event)

    const result = await stripeSync.postgresClient.query(
      `select id, status, billing_cycle_anchor from "${schema}"."subscriptions" where id = $1`,
      [subscriptionId]
    )

    expect(result.rows.length).toBe(1)
    expect(result.rows[0].status).toBe('active')
    expect(result.rows[0].billing_cycle_anchor).toBe(300)
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledTimes(1)
  })
})
