import { customerSchema } from '../schemas/customer'
import Stripe from 'stripe'
import { PostgresClient } from '../database/postgres'

export const upsertCustomers = async (
  customers: Stripe.Customer[],
  pgClient: PostgresClient
): Promise<Stripe.Customer[]> => {
  return pgClient.upsertMany(customers, 'customers', customerSchema)
  // return pgClient.upsertMany(customers, 'customers', (customer) => {
  //   // handle deleted customer
  //   if (customer.deleted) {
  //     return customerDeletedSchema
  //   } else {
  //     return customerSchema
  //   }
  // })
}

export const backfillCustomers = async (
  customerIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  const missingCustomerIds = await pgClient.findMissingEntries('customers', customerIds)
  await fetchAndInsertCustomers(missingCustomerIds, pgClient, stripe)
}

export const fetchAndInsertCustomers = async (
  customerIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  console.log('called here')
  console.log(customerIds)
  if (!customerIds.length) return

  const customers: Stripe.Customer[] = []

  for (const customerId of customerIds) {
    const customer = await stripe.customers.retrieve(customerId)
    customers.push(customer as Stripe.Customer)
  }

  await upsertCustomers(customers, pgClient)
}
