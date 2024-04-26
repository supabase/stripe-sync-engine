'use strict'
import { createHmac } from 'node:crypto'
import stripeMock from './helpers/stripe'
import 'dotenv/config'
import { ConfigType } from '../src/types/types'
import { PostgresClient } from '../src/database/postgres'
import Stripe from 'stripe'
import { handleWebhookEvent } from '../src/lib/webhooks'

let config: ConfigType
let pgClient: PostgresClient
let stripe: Stripe

beforeAll(async () => {
  config = {
    STRIPE_SECRET_KEY: 'sk_test_',
    DATABASE_URL: 'localhost',
    NODE_ENV: 'test',
    SCHEMA: 'stripe',
    AUTO_EXPAND_LISTS: true,
    PORT: 8080,
    API_KEY: 'api_key_test',
    STRIPE_API_VERSION: '2020-08-27',
    STRIPE_WEBHOOK_SECRET: 'whsec_',
  }
  pgClient = new PostgresClient({
    databaseUrl: config.DATABASE_URL,
    schema: config.SCHEMA,
  })
  stripe = new Stripe(config.STRIPE_SECRET_KEY, {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    apiVersion: config.STRIPE_API_VERSION,
    appInfo: {
      name: 'Stripe Postgres Sync',
    },
  })
})

jest.doMock('stripe', () => {
  return jest.fn(() => ({
    ...stripeMock,
    webhooks: stripe.webhooks,
  }))
})

jest.mock('../src/database/postgres', () => {
  return {
    PostgresClient: jest.fn().mockImplementation(() => {
      return {
        findMissingEntries: jest.fn().mockReturnValue([]),
        upsertMany: jest.fn(),
        deleteOne: jest.fn(),
        query: jest.fn().mockReturnValue({ rows: [] }),
      }
    }),
  }
})

const unixtime = Math.floor(new Date().getTime() / 1000)

describe('webhooks', () => {
  test.each([
    'customer_updated.json',
    'customer_deleted.json',
    'customer_tax_id_created.json',
    'customer_tax_id_deleted.json',
    'customer_tax_id_updated.json',
    'product_created.json',
    'product_deleted.json',
    'product_updated.json',
    'price_created.json',
    'price_deleted.json',
    'price_updated.json',
    'subscription_created.json',
    'subscription_deleted.json',
    'subscription_updated.json',
    'invoice_deleted.json',
    'invoice_paid.json',
    'invoice_updated.json',
    'invoice_finalized.json',
    'charge_captured.json',
    'charge_expired.json',
    'charge_failed.json',
    'charge_pending.json',
    'charge_refunded.json',
    'charge_succeeded.json',
    'charge_updated.json',
    'setup_intent_canceled.json',
    'setup_intent_created.json',
    'setup_intent_requires_action.json',
    'setup_intent_setup_failed.json',
    'setup_intent_succeeded.json',
    'subscription_schedule_aborted.json',
    'subscription_schedule_canceled.json',
    'subscription_schedule_completed.json',
    'subscription_schedule_created.json',
    'subscription_schedule_expiring.json',
    'subscription_schedule_released.json',
    'subscription_schedule_updated.json',
    'payment_method_attached.json',
    'payment_method_automatically_updated.json',
    'payment_method_detached.json',
    'payment_method_updated.json',
    'charge_dispute_closed',
    'charge_dispute_created',
    'charge_dispute_funds_reinstated',
    'charge_dispute_funds_withdrawn',
    'charge_dispute_updated',
    'plan_created',
    'plan_deleted',
    'plan_updated',
    'payment_intent_amount_capturable_updated',
    'payment_intent_canceled',
    'payment_intent_created',
    'payment_intent_partially_funded',
    'payment_intent_payment_failed',
    'payment_intent_processing',
    'payment_intent_requires_action',
    'payment_intent_succeeded',
  ])('process event %s', async (jsonFile) => {
    const eventBody = await import(`./stripe/${jsonFile}`).then(({ default: myData }) => myData)
    const signature = createHmac('sha256', config.STRIPE_WEBHOOK_SECRET)
      .update(`${unixtime}.${JSON.stringify(eventBody)}`, 'utf8')
      .digest('hex')
    const sig = `t=${unixtime},v1=${signature},v0=ff` as string

    const result = await handleWebhookEvent(
      pgClient,
      stripe,
      config,
      Buffer.from(JSON.stringify(eventBody)),
      sig
    )
    expect(result).toBeUndefined()
  })
})
