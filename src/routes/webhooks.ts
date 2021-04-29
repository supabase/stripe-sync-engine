import { FastifyInstance } from 'fastify'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { upsertCustomer } from '../lib/customers'
import { upsertProduct } from '../lib/products'
import { upsertPrice } from '../lib/prices'
import Product from 'stripe'

const config = getConfig()

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export default async function routes(fastify: FastifyInstance) {
  fastify.post('/webhooks', {
    handler: async (request, reply) => {
      const sig = request.headers['stripe-signature'] as string
      const body: { raw: Buffer } = request.body as { raw: Buffer }

      let event
      try {
        event = stripe.webhooks.constructEvent(body.raw, sig, config.STRIPE_WEBHOOK_SECRET)
      } catch (err) {
        return reply.code(400).send(`Webhook Error: ${err.message}`)
      }

      switch (event.type) {
        case 'customer.created':
        case 'customer.updated': {
          const customer = event.data.object as Product
          await upsertCustomer(customer)
          break
        }
        case 'product.created':
        case 'product.updated': {
          const product = event.data.object as Product
          await upsertProduct(product)
          break
        }
        case 'price.created':
        case 'price.updated': {
          const price = event.data.object as Product
          await upsertPrice(price)
          break
        }
        default:
          throw new Error('Unhandled webhook event')
      }

      return reply.send({ received: true })
    },
  })
}
