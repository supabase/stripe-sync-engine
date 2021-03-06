import { FastifyInstance } from 'fastify'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { upsertCustomer } from '../lib/customers'
import { upsertProduct, deleteProduct } from '../lib/products'
import { upsertPrice, deletePrice } from '../lib/prices'
import { upsertSubscription } from '../lib/subscriptions'
import { upsertInvoice } from '../lib/invoices'
import { upsertCharge } from '../lib/charges'
import Stripe from 'stripe'

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
        case 'charge.failed':
        case 'charge.refunded':
        case 'charge.succeeded': {
          const charge = event.data.object as Stripe.Charge
          await upsertCharge(charge)
          break
        }
        case 'customer.created':
        case 'customer.updated': {
          const customer = event.data.object as Stripe.Customer
          await upsertCustomer(customer)
          break
        }
        case 'customer.subscription.created':
        case 'customer.subscription.deleted': // Soft delete using `status = canceled`
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription
          await upsertSubscription(subscription)
          break
        }
        case 'invoice.created':
        case 'invoice.finalized':
        case 'invoice.paid':
        case 'invoice.payment_failed':
        case 'invoice.payment_succeeded':
        case 'invoice.updated': {
          const invoice = event.data.object as Stripe.Invoice
          await upsertInvoice(invoice)
          break
        }
        case 'product.created':
        case 'product.updated': {
          const product = event.data.object as Stripe.Product
          await upsertProduct(product)
          break
        }
        case 'product.deleted': {
          const product = event.data.object as Stripe.Product
          await deleteProduct(product.id)
          break
        }
        case 'price.created':
        case 'price.updated': {
          const price = event.data.object as Stripe.Price
          await upsertPrice(price)
          break
        }
        case 'price.deleted': {
          const price = event.data.object as Stripe.Price
          await deletePrice(price.id)
          break
        }
        default:
          throw new Error('Unhandled webhook event')
      }

      return reply.send({ received: true })
    },
  })
}
