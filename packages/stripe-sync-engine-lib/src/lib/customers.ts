import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { customerSchema, customerDeletedSchema } from '../schemas/customer'
import Stripe from 'stripe'
import { findMissingEntries, upsertMany } from './database_utils'

const config = getConfig()

export const upsertCustomers = async (customers: Stripe.Customer[]): Promise<Stripe.Customer[]> => {
  return upsertMany(customers, (customer) => {
    // handle deleted customer
    if (customer.deleted) {
      return constructUpsertSql(config.SCHEMA, 'customers', customerDeletedSchema)
    } else {
      return constructUpsertSql(config.SCHEMA, 'customers', customerSchema)
    }
  })
}

export const backfillCustomers = async (customerIds: string[]) => {
  const missingCustomerIds = await findMissingEntries('customers', customerIds)
  await fetchAndInsertCustomers(missingCustomerIds)
}

export const fetchAndInsertCustomers = async (customerIds: string[]) => {
  if (!customerIds.length) return

  const customers: Stripe.Customer[] = []

  for (const customerId of customerIds) {
    const customer = await stripe.customers.retrieve(customerId)
    customers.push(customer as Stripe.Customer)
  }

  await upsertCustomers(customers)
}
