import type Stripe from 'stripe'
import { StripeSync } from '@supabase/stripe-sync-engine'
import { vitest, beforeAll, describe, test, expect } from 'vitest'
import { runMigrations } from '@supabase/stripe-sync-engine'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'

let stripeSync: StripeSync

beforeAll(async () => {
  process.env.REVALIDATE_OBJECTS_VIA_STRIPE_API = 'invoice'

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

describe('invoices', () => {
  test('should revalidate entity if enabled', async () => {
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

    await stripeSync.upsertInvoices(invoices, false)

    const lineItems = await stripeSync.postgresClient.query(
      `select lines->'data' as lines from stripe.invoices where id = 'in_xyz' limit 1`
    )
    expect(lineItems.rows[0].lines).toEqual([{ id: 'li_123' }])
    expect(mockStripe.invoices.retrieve).toHaveBeenCalledTimes(1)
  })
})
