import { getConfig } from '../utils/config'
import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { paymentMethodsSchema } from '../schemas/payment_methods'
import { getUniqueIds, upsertMany } from './database_utils'

const config = getConfig()

export const upsertPaymentMethods = async (
  paymentMethods: Stripe.PaymentMethod[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.PaymentMethod[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(paymentMethods, 'customer'))
  }

  return upsertMany(paymentMethods, () =>
    constructUpsertSql(config.SCHEMA, 'payment_methods', paymentMethodsSchema)
  )
}
