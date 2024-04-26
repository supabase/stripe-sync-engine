import Stripe from 'stripe'
import { backfillCustomers } from './customers'
import { backfillInvoices } from './invoices'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'
import { paymentIntentSchema } from '../schemas/payment_intent'
import { ConfigType } from '../types/types'

export const upsertPaymentIntents = async (
  paymentIntents: Stripe.PaymentIntent[],
  pgClient: PostgresClient,
  stripe: Stripe,
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.PaymentIntent[]> => {
  if (backfillRelatedEntities) {
    await Promise.all([
      backfillCustomers(getUniqueIds(paymentIntents, 'customer'), pgClient, stripe),
      backfillInvoices(getUniqueIds(paymentIntents, 'invoice'), pgClient, stripe, config),
    ])
  }

  return pgClient.upsertMany(paymentIntents, 'payment_intents', paymentIntentSchema)
}
