import { FastifyInstance } from 'fastify'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { upsertCustomers } from '../lib/customers'
import { upsertProducts, deleteProduct } from '../lib/products'
import { upsertPrices, deletePrice } from '../lib/prices'
import { upsertSubscriptions } from '../lib/subscriptions'
import { upsertInvoices } from '../lib/invoices'
import { upsertCharges } from '../lib/charges'
import Stripe from 'stripe'
import { upsertSetupIntents } from '../lib/setup_intents'
import { upsertPaymentMethods } from '../lib/payment_methods'
import { upsertDisputes } from '../lib/disputes'
import { deletePlan, upsertPlans } from '../lib/plans'
import { upsertPaymentIntents } from '../lib/payment_intents'
import { upsertSubscriptionSchedules } from '../lib/subscription_schedules'
import { deleteTaxId, upsertTaxIds } from '../lib/tax_ids'
import { upsertCreditNotes } from '../lib/creditNotes'
import { logger } from '../logger'

const config = getConfig()

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

          logger.info(`Received webhook ${event.id}: ${event.type} for charge ${charge.id}`)

          await upsertCharges([charge])
          break
        }
        case 'customer.created':
        case 'customer.deleted':
        case 'customer.updated': {
          const customer = event.data.object as Stripe.Customer

          logger.info(`Received webhook ${event.id}: ${event.type} for customer ${customer.id}`)

          await upsertCustomers([customer])
          break
        }
        case 'customer.subscription.created':
        case 'customer.subscription.deleted': // Soft delete using `status = canceled`
        case 'customer.subscription.paused':
        case 'customer.subscription.pending_update_applied':
        case 'customer.subscription.pending_update_expired':
        case 'customer.subscription.trial_will_end':
        case 'customer.subscription.resumed':
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription

          logger.info(
            `Received webhook ${event.id}: ${event.type} for subscription ${subscription.id}`
          )

          await upsertSubscriptions([subscription])
          break
        }
        case 'customer.tax_id.updated':
        case 'customer.tax_id.created': {
          const taxId = event.data.object as Stripe.TaxId

          logger.info(`Received webhook ${event.id}: ${event.type} for taxId ${taxId.id}`)

          await upsertTaxIds([taxId])
          break
        }
        case 'customer.tax_id.deleted': {
          const taxId = event.data.object as Stripe.TaxId

          logger.info(`Received webhook ${event.id}: ${event.type} for taxId ${taxId.id}`)

          await deleteTaxId(taxId.id)
          break
        }
        case 'invoice.created':
        case 'invoice.deleted':
        case 'invoice.finalized':
        case 'invoice.finalization_failed':
        case 'invoice.paid':
        case 'invoice.payment_action_required':
        case 'invoice.payment_failed':
        case 'invoice.payment_succeeded':
        case 'invoice.upcoming':
        case 'invoice.sent':
        case 'invoice.voided':
        case 'invoice.marked_uncollectible':
        case 'invoice.updated': {
          const invoice = event.data.object as Stripe.Invoice

          logger.info(`Received webhook ${event.id}: ${event.type} for invoice ${invoice.id}`)

          await upsertInvoices([invoice])
          break
        }
        case 'product.created':
        case 'product.updated': {
          const product = event.data.object as Stripe.Product

          logger.info(`Received webhook ${event.id}: ${event.type} for product ${product.id}`)

          await upsertProducts([product])
          break
        }
        case 'product.deleted': {
          const product = event.data.object as Stripe.Product

          logger.info(`Received webhook ${event.id}: ${event.type} for product ${product.id}`)

          await deleteProduct(product.id)
          break
        }
        case 'price.created':
        case 'price.updated': {
          const price = event.data.object as Stripe.Price

          logger.info(`Received webhook ${event.id}: ${event.type} for price ${price.id}`)

          await upsertPrices([price])
          break
        }
        case 'price.deleted': {
          const price = event.data.object as Stripe.Price

          logger.info(`Received webhook ${event.id}: ${event.type} for price ${price.id}`)

          await deletePrice(price.id)
          break
        }
        case 'plan.created':
        case 'plan.updated': {
          const plan = event.data.object as Stripe.Plan

          logger.info(`Received webhook ${event.id}: ${event.type} for plan ${plan.id}`)

          await upsertPlans([plan])
          break
        }
        case 'plan.deleted': {
          const plan = event.data.object as Stripe.Plan

          logger.info(`Received webhook ${event.id}: ${event.type} for plan ${plan.id}`)

          await deletePlan(plan.id)
          break
        }
        case 'setup_intent.canceled':
        case 'setup_intent.created':
        case 'setup_intent.requires_action':
        case 'setup_intent.setup_failed':
        case 'setup_intent.succeeded': {
          const setupIntent = event.data.object as Stripe.SetupIntent

          logger.info(
            `Received webhook ${event.id}: ${event.type} for setupIntent ${setupIntent.id}`
          )

          await upsertSetupIntents([setupIntent])
          break
        }
        case 'subscription_schedule.aborted':
        case 'subscription_schedule.canceled':
        case 'subscription_schedule.completed':
        case 'subscription_schedule.created':
        case 'subscription_schedule.expiring':
        case 'subscription_schedule.released':
        case 'subscription_schedule.updated': {
          const subscriptionSchedule = event.data.object as Stripe.SubscriptionSchedule

          logger.info(
            `Received webhook ${event.id}: ${event.type} for subscriptionSchedule ${subscriptionSchedule.id}`
          )

          await upsertSubscriptionSchedules([subscriptionSchedule])
          break
        }
        case 'payment_method.attached':
        case 'payment_method.automatically_updated':
        case 'payment_method.detached':
        case 'payment_method.updated': {
          const paymentMethod = event.data.object as Stripe.PaymentMethod

          logger.info(
            `Received webhook ${event.id}: ${event.type} for paymentMethod ${paymentMethod.id}`
          )

          await upsertPaymentMethods([paymentMethod])
          break
        }
        case 'charge.dispute.created':
        case 'charge.dispute.funds_reinstated':
        case 'charge.dispute.funds_withdrawn':
        case 'charge.dispute.updated':
        case 'charge.dispute.closed': {
          const dispute = event.data.object as Stripe.Dispute

          logger.info(`Received webhook ${event.id}: ${event.type} for dispute ${dispute.id}`)

          await upsertDisputes([dispute])
          break
        }
        case 'payment_intent.amount_capturable_updated':
        case 'payment_intent.canceled':
        case 'payment_intent.created':
        case 'payment_intent.partially_funded':
        case 'payment_intent.payment_failed':
        case 'payment_intent.processing':
        case 'payment_intent.requires_action':
        case 'payment_intent.succeeded': {
          const paymentIntent = event.data.object as Stripe.PaymentIntent

          logger.info(
            `Received webhook ${event.id}: ${event.type} for paymentIntent ${paymentIntent.id}`
          )

          await upsertPaymentIntents([paymentIntent])
          break
        }

        case 'credit_note.created':
        case 'credit_note.updated':
        case 'credit_note.voided': {
          const creditNote = event.data.object as Stripe.CreditNote

          logger.info(`Received webhook ${event.id}: ${event.type} for creditNote ${creditNote.id}`)

          await upsertCreditNotes([creditNote])
          break
        }

        default:
          throw new Error('Unhandled webhook event')
      }

      return reply.send({ received: true })
    },
  })
}
