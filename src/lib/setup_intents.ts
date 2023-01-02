import { getConfig } from '../utils/config'
import Stripe from 'stripe'
import { cleanseArrayField, constructUpsertSql } from '../utils/helpers'
import { pg as sql } from 'yesql'
import { query } from '../utils/PostgresConnection'
import { stripe } from '../utils/StripeClientManager'
import { setupIntentsSchema } from '../schemas/setupIntents'
import { upsertCustomer } from './customers'

const config = getConfig()

export const upsertSetupIntent = async (
  setupIntent: Stripe.SetupIntent
): Promise<Stripe.SetupIntent[]> => {
  // Backfill customer if it doesn't already exist
  const customerId = setupIntent.customer?.toString()
  if (customerId && !(await verifyCustomerExists(customerId))) {
    await fetchAndInsertSetupIntent(customerId)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(
    config.SCHEMA || 'stripe',
    'setup_intents',
    setupIntentsSchema
  )

  // Inject the values
  const cleansed = cleanseArrayField(setupIntent)
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

export const fetchAndInsertSetupIntent = async (customerId: string): Promise<Stripe.Customer[]> => {
  const customer = await stripe.customers.retrieve(customerId)
  return upsertCustomer(customer as Stripe.Customer)
}

type fetchSetupIntentResponse = Stripe.Response<Stripe.ApiList<Stripe.SetupIntent>>
type fetchSetupIntentParams = {
  limit: number
  id: string | undefined
}
const fetchSetupIntentsDefaults = {
  limit: 100,
  id: undefined,
}
export const fetchSetupIntents = async (
  options: fetchSetupIntentParams = fetchSetupIntentsDefaults
): Promise<fetchSetupIntentResponse> => {
  const setupIntents = await stripe.setupIntents.list({
    limit: options.limit,
  })
  return setupIntents
}
