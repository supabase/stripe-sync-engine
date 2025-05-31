import 'dotenv/config'
import Stripe from 'stripe'
import { StripeSync } from '../src/stripeSync'
import { getConfig } from '../src/utils/config'

let stripeSync: StripeSync

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      invoices: {
        listLineItems: () => [{ id: 'li_123' }, { id: 'li_1234' }],
      },
    }
  })
})

beforeAll(() => {
  process.env.AUTO_EXPAND_LISTS = 'true'

  const config = getConfig()
  stripeSync = new StripeSync(config)
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
