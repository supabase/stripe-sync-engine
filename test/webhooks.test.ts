'use strict'
import app from '../src/app'
import { createHmac } from 'crypto'
import customer_updated from './stripe/customer_updated.json'
import product_updated from './stripe/product_updated.json'
import price_updated from './stripe/price_updated.json'
import subscription_updated from './stripe/subscription_updated.json'

const unixtime = Math.floor(new Date().getTime() / 1000)
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''

describe('/webhooks', () => {
  /**
   * customer.updated
   */
  test('customer.updated', async () => {
    const signature = createHmac('sha256', stripeWebhookSecret)
      .update(`${unixtime}.${JSON.stringify(customer_updated)}`, 'utf8')
      .digest('hex')

    const response = await app().inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: customer_updated,
    })

    const json = JSON.parse(response.body)
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

    const response = await app().inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: product_updated,
    })

    const json = JSON.parse(response.body)
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

    const response = await app().inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: price_updated,
    })

    const json = JSON.parse(response.body)
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

    const response = await app().inject({
      url: `/webhooks`,
      method: 'POST',
      headers: {
        'stripe-signature': `t=${unixtime},v1=${signature},v0=ff`,
      },
      payload: subscription_updated,
    })

    const json = JSON.parse(response.body)
    expect(response.statusCode).toBe(200)
    expect(json).toMatchObject({ received: true })
  })
})
