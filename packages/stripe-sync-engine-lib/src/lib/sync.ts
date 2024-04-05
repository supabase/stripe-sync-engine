import Stripe from 'stripe'
import { stripe } from '../utils/StripeClientManager'
import { upsertCustomers } from './customers'
import { upsertInvoices } from './invoices'
import { upsertPrices } from './prices'
import { upsertProducts } from './products'
import { upsertSubscriptions } from './subscriptions'
import { upsertSetupIntents } from './setup_intents'
import { upsertPaymentMethods } from './payment_methods'
import { upsertDisputes } from './disputes'
import { upsertCharges } from './charges'
import { upsertPaymentIntents } from './payment_intents'
import { upsertTaxIds } from './tax_ids'

interface Sync {
  synced: number
}

interface SyncBackfill {
  products?: Sync
  prices?: Sync
  plans?: Sync

  customers?: Sync
  subscriptions?: Sync
  subscriptionSchedules?: Sync
  invoices?: Sync

  setupIntents?: Sync
  paymentIntents?: Sync
  paymentMethods?: Sync

  disputes?: Sync
  charges?: Sync
  taxIds?: Sync
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam

  object?: SyncObject
  backfillRelatedEntities?: boolean
}

type SyncObject =
  | 'all'
  | 'customer'
  | 'invoice'
  | 'price'
  | 'product'
  | 'subscription'
  | 'subscription_schedules'
  | 'setup_intent'
  | 'payment_method'
  | 'dispute'
  | 'charge'
  | 'payment_intent'
  | 'plan'
  | 'tax_id'

export async function syncSingleEntity(stripeId: string) {
  if (stripeId.startsWith('cus_')) {
    return stripe.customers.retrieve(stripeId).then((it) => {
      if (!it || it.deleted) return

      return upsertCustomers([it])
    })
  } else if (stripeId.startsWith('in_')) {
    return stripe.invoices.retrieve(stripeId).then((it) => upsertInvoices([it]))
  } else if (stripeId.startsWith('price_')) {
    return stripe.prices.retrieve(stripeId).then((it) => upsertPrices([it]))
  } else if (stripeId.startsWith('prod_')) {
    return stripe.products.retrieve(stripeId).then((it) => upsertProducts([it]))
  } else if (stripeId.startsWith('sub_')) {
    return stripe.subscriptions.retrieve(stripeId).then((it) => upsertSubscriptions([it]))
  } else if (stripeId.startsWith('seti_')) {
    return stripe.setupIntents.retrieve(stripeId).then((it) => upsertSetupIntents([it]))
  } else if (stripeId.startsWith('pm_')) {
    return stripe.paymentMethods.retrieve(stripeId).then((it) => upsertPaymentMethods([it]))
  } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
    return stripe.disputes.retrieve(stripeId).then((it) => upsertDisputes([it]))
  } else if (stripeId.startsWith('ch_')) {
    return stripe.charges.retrieve(stripeId).then((it) => upsertCharges([it]))
  } else if (stripeId.startsWith('pi_')) {
    return stripe.paymentIntents.retrieve(stripeId).then((it) => upsertPaymentIntents([it]))
  } else if (stripeId.startsWith('txi_')) {
    return stripe.taxIds.retrieve(stripeId).then((it) => upsertTaxIds([it]))
  }
}

export interface SyncBackfillParams {
  created?: Stripe.RangeQueryParam
  object?: SyncObject
  backfillRelatedEntities?: boolean
}

export async function syncBackfill(params?: SyncBackfillParams): Promise<SyncBackfill> {
  console.log('syncBackfill')
  console.log(params)
  return {}
}
