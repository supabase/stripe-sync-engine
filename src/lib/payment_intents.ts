import { getConfig } from '../utils/config'
import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'
import { backfillInvoices } from './invoices'
import { paymentIntentSchema } from '../schemas/payment_intent'

const config = getConfig()

export const upsertPaymentIntents = async (
  paymentIntents: Stripe.PaymentIntent[]
): Promise<Stripe.PaymentIntent[]> => {
  await Promise.all([
    backfillCustomers(getUniqueIds(paymentIntents, 'customer')),
    backfillInvoices(getUniqueIds(paymentIntents, 'invoice')),
  ])

  return upsertMany(paymentIntents, () =>
    constructUpsertSql(config.SCHEMA || 'stripe', 'payment_intents', paymentIntentSchema)
  )
}
