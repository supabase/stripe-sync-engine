import { getConfig } from '../utils/config'
import Stripe from 'stripe'
import { cleanseArrayField, constructUpsertSql } from '../utils/helpers'
import { pg as sql } from 'yesql'
import { query } from '../utils/PostgresConnection'
import { stripe } from '../utils/StripeClientManager'
import { upsertCustomer } from './customers'
import { paymentMethodsSchema } from '../schemas/payment_methods'

const config = getConfig()

export const upsertPaymentMethod = async (
  paymentMethod: Stripe.PaymentMethod
): Promise<Stripe.PaymentMethod[]> => {
  // Backfill customer if it doesn't already exist
  const customerId = paymentMethod.customer?.toString()
  if (customerId && !(await verifyCustomerExists(customerId))) {
    await fetchAndInsertCustomer(customerId)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(
    config.SCHEMA || 'stripe',
    'payment_methods',
    paymentMethodsSchema
  )

  // Inject the values
  const cleansed = cleanseArrayField(paymentMethod)
  const prepared = sql(upsertString)(cleansed)

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

export const fetchAndInsertCustomer = async (customerId: string): Promise<Stripe.Customer[]> => {
  const customer = await stripe.customers.retrieve(customerId)
  return upsertCustomer(customer as Stripe.Customer)
}

type fetchPaymentMethodResponse = Stripe.Response<Stripe.ApiList<Stripe.PaymentMethod>>
type fetchPaymentMethodParams = {
  limit: number
  id: string | undefined
  type: Stripe.PaymentMethodListParams.Type
}

const fetchPaymentMethodsDefaults = {
  limit: 10,
  id: undefined,
  type: 'card',
} as fetchPaymentMethodParams

export const fetchPaymentMethods = async (
  options: fetchPaymentMethodParams = fetchPaymentMethodsDefaults
): Promise<fetchPaymentMethodResponse> => {
  const paymentMethods = await stripe.paymentMethods.list({
    limit: options.limit,
    type: options.type,
  })
  return paymentMethods
}
