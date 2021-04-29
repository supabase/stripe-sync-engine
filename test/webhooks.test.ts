'use strict'
import app from '../src/app'
import { createHmac } from 'crypto'
import customer_updated from './stripe/customer_updated.json'
import product_updated from './stripe/product_updated.json'

const unixtime = Math.floor(new Date().getTime() / 1000)
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''

describe('/webhooks', () => {
  test('customer.updated', async () => {
    // Calculate the signature using the UNIX timestamp, postData and webhook secret
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
  test('product.updated', async () => {
    // Calculate the signature using the UNIX timestamp, postData and webhook secret
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
})
