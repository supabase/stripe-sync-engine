import Customer from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
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
