import 'dotenv/config'
import Stripe from 'stripe'
import { upsertInvoices } from '../src/lib/invoices'
import { upsertMany } from '../src/lib/database_utils'

jest.mock('../src/lib/database_utils')

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

    await upsertInvoices(invoices, false)

    expect(upsertMany).toHaveBeenCalledWith(invoices, expect.any(Function))
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

    await upsertInvoices(invoices, false)

    const expectedInvoices = [
      {
        id: 'in_xyz2',
        object: 'invoice',
        auto_advance: true,
        lines: {
          data: [{ id: 'li_123' }, { id: 'li_1234' }],
          has_more: false,
        },
      } as Stripe.Invoice,
    ]

    expect(upsertMany).toHaveBeenCalledWith(expectedInvoices, expect.any(Function))
  })
})
