import Stripe from 'stripe'
import { upsertCharges } from './charges'
import { upsertCustomers } from './customers'
import { upsertSubscriptions } from './subscriptions'
import { deletePlan, upsertPlans } from './plans'
import { upsertSetupIntents } from './setup_intents'
import { upsertSubscriptionSchedules } from './subscription_schedules'
import { upsertPaymentMethods } from './payment_methods'
import { upsertDisputes } from './disputes'
import { upsertPaymentIntents } from './payment_intents'
import { deleteTaxId, upsertTaxIds } from './tax_ids'
import { upsertInvoices } from './invoices'
import { deleteProduct, upsertProducts } from './products'
import { deletePrice, upsertPrices } from './prices'
import { PostgresClient } from '../database/postgres'
import { ConfigType } from '../types/types'

export async function handleWebhookEvent(
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  webhookData: Buffer,
  sig: string
) {
  let event
  try {
    event = stripe.webhooks.constructEvent(webhookData, sig, config.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    throw new Error('Webhook signature verification failed')
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
      await upsertCharges([charge], pgClient, stripe, config)
      break
    }
    case 'customer.created':
    case 'customer.deleted':
    case 'customer.updated': {
      const customer = event.data.object as Stripe.Customer
      await upsertCustomers([customer], pgClient)
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
      await upsertSubscriptions([subscription], pgClient, stripe, config)
      break
    }
    case 'customer.tax_id.updated':
    case 'customer.tax_id.created': {
      const taxId = event.data.object as Stripe.TaxId
      await upsertTaxIds([taxId], pgClient, stripe)
      break
    }
    case 'customer.tax_id.deleted': {
      const taxId = event.data.object as Stripe.TaxId
      await deleteTaxId(taxId.id, pgClient)
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
      await upsertInvoices([invoice], pgClient, stripe, config)

      break
    }
    case 'product.created':
    case 'product.updated': {
      const product = event.data.object as Stripe.Product
      await upsertProducts([product], pgClient)
      break
    }

    case 'product.deleted': {
      const product = event.data.object as Stripe.Product
      await deleteProduct(product.id, pgClient)
      break
    }
    case 'price.created':
    case 'price.updated': {
      const price = event.data.object as Stripe.Price
      await upsertPrices([price], pgClient, stripe)
      break
    }
    case 'price.deleted': {
      const price = event.data.object as Stripe.Price
      await deletePrice(price.id, pgClient)
      break
    }
    case 'plan.created':
    case 'plan.updated': {
      const plan = event.data.object as Stripe.Plan
      await upsertPlans([plan], pgClient, stripe)
      break
    }
    case 'plan.deleted': {
      const plan = event.data.object as Stripe.Plan
      await deletePlan(plan.id, pgClient)
      break
    }
    case 'setup_intent.canceled':
    case 'setup_intent.created':
    case 'setup_intent.requires_action':
    case 'setup_intent.setup_failed':
    case 'setup_intent.succeeded': {
      const setupIntent = event.data.object as Stripe.SetupIntent

      await upsertSetupIntents([setupIntent], pgClient, stripe)
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

      await upsertSubscriptionSchedules([subscriptionSchedule], pgClient, stripe)
      break
    }
    case 'payment_method.attached':
    case 'payment_method.automatically_updated':
    case 'payment_method.detached':
    case 'payment_method.updated': {
      const paymentMethod = event.data.object as Stripe.PaymentMethod

      await upsertPaymentMethods([paymentMethod], pgClient, stripe)
      break
    }
    case 'charge.dispute.closed':
    case 'charge.dispute.created':
    case 'charge.dispute.funds_reinstated':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute

      await upsertDisputes([dispute], pgClient, stripe, config)
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

      await upsertPaymentIntents([paymentIntent], pgClient, stripe, config)
      break
    }
    default:
      throw new Error('Unhandled webhook event')
  }
  return
}
