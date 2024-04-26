import 'dotenv/config'
import Stripe from 'stripe'
import { upsertInvoices } from '../src/lib/invoices'
import { PostgresClient } from '../src/database/postgres'
import { ConfigType } from '../src/types/types'
import { invoiceSchema } from '../src/schemas/invoice'

jest.mock('../src/database/postgres')

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => {
    return {
      invoices: {
        listLineItems: () => [{ id: 'li_123' }, { id: 'li_1234' }],
      },
    }
  })
})

let configLocal: ConfigType
let pgClient: PostgresClient
let stripe: Stripe

beforeAll(() => {
  configLocal = {
    STRIPE_SECRET_KEY: 'demo',
    DATABASE_URL: 'demo',
    NODE_ENV: 'test',
    SCHEMA: 'public',
    AUTO_EXPAND_LISTS: true,
    PORT: 8080,
    API_KEY: 'demo',
    STRIPE_API_VERSION: '2020-08-27',
    STRIPE_WEBHOOK_SECRET: 'demo',
  }
  pgClient = new PostgresClient({
    databaseUrl: configLocal.DATABASE_URL,
    schema: configLocal.SCHEMA,
  })
  stripe = new Stripe(configLocal.STRIPE_SECRET_KEY, {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    apiVersion: configLocal.STRIPE_API_VERSION,
    appInfo: {
      name: 'Stripe Postgres Sync',
    },
  })
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

    await upsertInvoices(invoices, pgClient, stripe, configLocal, false)

    expect(pgClient.upsertMany).toHaveBeenCalledWith(invoices, 'invoices', invoiceSchema)
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

    await upsertInvoices(invoices, pgClient, stripe, configLocal, false)

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

    expect(pgClient.upsertMany).toHaveBeenCalledWith(expectedInvoices, 'invoices', invoiceSchema)
  })
})
