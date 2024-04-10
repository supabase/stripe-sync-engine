import { constructUpsertSql } from '../utils/helpers'
import { customerSchema, customerDeletedSchema } from '../schemas/customer'
import Stripe from 'stripe'
import { findMissingEntries, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertCustomers = async (
  customers: Stripe.Customer[],
  config: ConfigType
): Promise<Stripe.Customer[]> => {
  return upsertMany(
    customers,
    (customer) => {
      // handle deleted customer
      if (customer.deleted) {
        return constructUpsertSql(config.SCHEMA, 'customers', customerDeletedSchema)
      } else {
        return constructUpsertSql(config.SCHEMA, 'customers', customerSchema)
      }
    },
    config.DATABASE_URL
  )
}

export const backfillCustomers = async (customerIds: string[], config: ConfigType) => {
  const missingCustomerIds = await findMissingEntries('customers', customerIds, config)
  await fetchAndInsertCustomers(missingCustomerIds, config)
}

export const fetchAndInsertCustomers = async (customerIds: string[], config: ConfigType) => {
  if (!customerIds.length) return

  const customers: Stripe.Customer[] = []

  for (const customerId of customerIds) {
    const customer = await getStripe(config).customers.retrieve(customerId)
    customers.push(customer as Stripe.Customer)
  }

  await upsertCustomers(customers, config)
}
