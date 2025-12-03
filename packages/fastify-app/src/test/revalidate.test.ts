import { StripeSync, runMigrations } from 'stripe-experiment-sync'
import { PgAdapter } from 'stripe-experiment-sync/pg'
import { vitest, beforeAll, describe, test, expect, afterEach } from 'vitest'
import { getConfig } from '../utils/config'
import { mockStripe } from './helpers/mockStripe'
import { logger } from '../logger'
import type Stripe from 'stripe'

let stripeSync: StripeSync

beforeAll(async () => {
  process.env.REVALIDATE_OBJECTS_VIA_STRIPE_API = 'invoice'

  const config = getConfig()
  const adapter = new PgAdapter({
    connectionString: config.databaseUrl,
  })

  await runMigrations(adapter, logger)

  stripeSync = new StripeSync({
    ...config,
    adapter,
  })
  const stripe = Object.assign(stripeSync.stripe, mockStripe)
  vitest.spyOn(stripeSync, 'stripe', 'get').mockReturnValue(stripe)
})

afterEach(() => {
  vitest.clearAllMocks()
})

describe('invoices', () => {
  test('should revalidate entity if enabled', async () => {
    const eventBody = await import(`./stripe/invoice_finalized.json`).then(
      ({ default: myData }) => myData
    )

    await stripeSync.processEvent(eventBody as unknown as Stripe.Event)

    const result = await stripeSync.postgresClient.query(
      `select customer from stripe.invoices where id = 'in_1KJdKkJDPojXS6LNSwSWkZSN' limit 1`
    )
    expect(mockStripe.invoices.retrieve).toHaveBeenCalled()
    expect(result.rows[0].customer).toEqual('cus_J7Mkgr8mvbl1eK') // from stripe mock
  })

  test('should not revalidate if entity in final status', async () => {
    const eventBody = await import(`./stripe/invoice_voided.json`).then(
      ({ default: myData }) => myData
    )

    await stripeSync.processEvent(eventBody as unknown as Stripe.Event)

    const result = await stripeSync.postgresClient.query(
      `select customer from stripe.invoices where id = 'in_1KJqKBJDPojXS6LNJbvLUgEy' limit 1`
    )
    expect(mockStripe.invoices.retrieve).not.toHaveBeenCalled()
    expect(result.rows[0].customer).toEqual('cus_JsuO3bmrj0QlAw') // from webhook, no refetch
  })
})
