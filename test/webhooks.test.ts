'use strict'
import { FastifyInstance } from 'fastify'
import { createHmac } from 'crypto'
import { createServer } from '../src/app'
import customer_updated from './stripe/customer_updated.json'
import product_created from './stripe/product_created.json'
import product_deleted from './stripe/product_deleted.json'
import product_updated from './stripe/product_updated.json'
import price_created from './stripe/price_created.json'
import price_deleted from './stripe/price_deleted.json'
import price_updated from './stripe/price_updated.json'
import subscription_created from './stripe/subscription_created.json'
import subscription_deleted from './stripe/subscription_deleted.json'
import subscription_updated from './stripe/subscription_updated.json'
import invoice_paid from './stripe/invoice_paid.json'
import invoice_updated from './stripe/invoice_updated.json'
import invoice_finalized from './stripe/invoice_finalized.json'
import charge_failed from './stripe/charge_failed.json'
import charge_refunded from './stripe/charge_refunded.json'
import charge_succeeded from './stripe/charge_succeeded.json'
import stripeMock from './helpers/stripe'

jest.doMock('stripe', () => {
  return jest.fn(() => stripeMock)
})

const unixtime = Math.floor(new Date().getTime() / 1000)
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''

describe('/webhooks', () => {
  let server: FastifyInstance

  beforeAll(async () => {
    server = await createServer()
  })

  afterAll(async () => {
    await server.close()
  })

  /**
   * customer.updated
   */
  test('customer.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(customer_updated)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: customer_updated,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * product.updated
   */
  test('product.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(product_updated)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: product_updated,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * product.created
   */
  test('product.created', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(product_created)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: product_created,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * product.deleted
   */
  test('product.deleted', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(product_deleted)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: product_deleted,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * price.updated
   */
  test('price.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(price_updated)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: price_updated,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * price.created
   */
  test('product.created', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(price_created)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: price_created,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * price.deleted
   */
  test('product.deleted', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(price_deleted)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: price_deleted,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * subscription.created
   */
  test('subscription.created', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(subscription_created)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: subscription_created,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * subscription.deleted
   */
  test('subscription.deleted', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(subscription_deleted)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: subscription_deleted,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * subscription.updated
   */
  test('subscription.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(subscription_updated)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: subscription_updated,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * invoice.updated
   */
  test('invoice.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(invoice_updated)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: invoice_updated,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * invoice.paid
   */
  test('invoice.paid', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(invoice_paid)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: invoice_paid,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * invoice.finalized
   */
  test('invoice.finalized', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(invoice_finalized)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: invoice_finalized,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * charge.failed
   */
  test('charge.failed', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(charge_failed)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: charge_failed,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * charge.refunded
   */
  test('charge.refunded', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(charge_refunded)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: charge_refunded,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
  /**
   * charge.succeeded
   */
  test('charge.succeeded', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(charge_succeeded)}`, 'utf8')
      .digest('hex')

    const response = await server.inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: charge_succeeded,
    })

    const json = JSON.parse(response.body)
    if (json.error) {
      console.log('error: ', json.message)
    }
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
})
