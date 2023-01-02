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
import { upsertSetupIntent } from '../lib/setup_intents'
import { upsertPaymentMethod } from '../lib/payment_methods'
import { upsertDispute } from '../lib/disputes'

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
        case 'charge.captured':
        case 'charge.expired':
        case 'charge.failed':
        case 'charge.pending':
        case 'charge.refunded':
        case 'charge.succeeded':
        case 'charge.updated': {
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
        case 'setup_intent.canceled':
        case 'setup_intent.created':
        case 'setup_intent.requires_action':
        case 'setup_intent.setup_failed':
        case 'setup_intent.succeeded': {
          const setupIntent = event.data.object as Stripe.SetupIntent

          await upsertSetupIntent(setupIntent)
          break
        }
        case 'payment_method.attached':
        case 'payment_method.automatically_updated':
        case 'payment_method.detached':
        case 'payment_method.updated': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod

          await upsertPaymentMethod(paymentMethod)
          break
        }
        case 'charge.dispute.closed':
        case 'charge.dispute.created':
        case 'charge.dispute.funds_reinstated':
        case 'charge.dispute.funds_withdrawn':
        case 'charge.dispute.updated':
        case 'charge.dispute.closed': {
          const dispute = event.data.object as Stripe.Dispute

          await upsertDispute(dispute)
          break
        }

        default:
          throw new Error('Unhandled webhook event')
      }

      return reply.send({ received: true })
    },
  })
}
