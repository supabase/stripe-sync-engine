import Customer from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { customerSchema } from '../schemas/customer'

const config = getConfig()

export const upsertCustomer = async (customer: Customer.Customer): Promise<Customer.Customer[]> => {
  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'customers', customerSchema)

  // Inject the values
  const prepared = sql(upsertString)(customer)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifyCustomerExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."customers" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertCustomer = async (id: string): Promise<Customer.Customer[]> => {
  const customer = await stripe.customers.retrieve(id)
  return upsertCustomer(customer as Customer.Customer)
}
