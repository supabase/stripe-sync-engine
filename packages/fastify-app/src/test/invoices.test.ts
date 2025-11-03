import type Stripe from 'stripe'
import { StripeSync } from '@supabase/stripe-sync-engine'
import { vitest, beforeAll, describe, test, expect } from 'vitest'
import { runMigrations } from '@supabase/stripe-sync-engine'
import { getConfig } from '../utils/config.js'
import { mockStripe } from './helpers/mockStripe.js'
import { logger } from '../logger.js'

let stripeSync: StripeSync

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

    await stripeSync.upsertInvoices(invoices, false)

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

    await stripeSync.upsertInvoices(invoices, false)

    const lineItems = await stripeSync.postgresClient.query(
      `select lines->'data' as lines from stripe.invoices where id = 'in_xyz2' limit 1`
    )
    expect(lineItems.rows[0].lines).toEqual([{ id: 'li_123' }, { id: 'li_1234' }])
  })
})
