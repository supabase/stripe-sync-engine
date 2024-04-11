import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'
import { backfillInvoices } from './invoices'
import { paymentIntentSchema } from '../schemas/payment_intent'
import { ConfigType } from '../types/types'

export const upsertPaymentIntents = async (
  paymentIntents: Stripe.PaymentIntent[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.PaymentIntent[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(paymentIntents, 'customer'), config),
      backfillInvoices(getUniqueIds(paymentIntents, 'invoice'), config),
    ])
  }

  return upsertMany(
    paymentIntents,
    () => constructUpsertSql(config.SCHEMA, 'payment_intents', paymentIntentSchema),
    config.DATABASE_URL
  )
}
