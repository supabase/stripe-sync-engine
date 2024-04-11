import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { paymentMethodsSchema } from '../schemas/payment_methods'
import { getUniqueIds, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'

export const upsertPaymentMethods = async (
  paymentMethods: Stripe.PaymentMethod[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.PaymentMethod[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(paymentMethods, 'customer'), config)
  }

  return upsertMany(
    paymentMethods,
    () => constructUpsertSql(config.SCHEMA, 'payment_methods', paymentMethodsSchema),
    config.DATABASE_URL
  )
}
