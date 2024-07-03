'use strict'
import { FastifyInstance } from 'fastify'
import { createHmac } from 'node:crypto'
import { createServer } from '../src/app'
import { getConfig } from '../src/utils/config'
import stripeMock from './helpers/stripe'
import 'dotenv/config'

jest.doMock('stripe', () => {
  return jest.fn(() => stripeMock)
})

const unixtime = Math.floor(new Date().getTime() / 1000)
const stripeWebhookSecret = getConfig().STRIPE_WEBHOOK_SECRET

describe('/webhooks', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await createServer()
  })

  afterAll(async () => {
    await server.close()
  })

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
    'credit_note_created',
    'credit_note_updated',
    'credit_note_voided',
  ])('process event %s', async (jsonFile) => {
    const eventBody = await import(`./stripe/${jsonFile}`).then(({ default: myData }) => myData)
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(eventBody)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: eventBody,
    })

    const json = JSON.parse(response.body)
    if (response.statusCode != 200) {
      console.log('error: ', json)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
})
