import Stripe from 'stripe'
import { backfillCustomers } from './customers'
import { paymentMethodsSchema } from '../schemas/payment_methods'
import { getUniqueIds } from '../database/utils'
import { PostgresClient } from '../database/postgres'

export const upsertPaymentMethods = async (
  paymentMethods: Stripe.PaymentMethod[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.PaymentMethod[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(paymentMethods, 'customer'), pgClient, stripe)
  }

  return pgClient.upsertMany(paymentMethods, 'payment_methods', paymentMethodsSchema)
}
