import Subscription from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { subscriptionSchema } from '../schemas/subscription'

const config = getConfig()

export const upsertSubscription = async (
  subscription: Subscription.Subscription
): Promise<Subscription.Subscription[]> => {
  // Create the SQL
  const upsertString = constructUpsertSql(
    config.SCHEMA || 'stripe',
    'subscriptions',
    subscriptionSchema
  )

  // Inject the values
  const prepared = sql(upsertString)(subscription)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifySubscriptionExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."subscriptions" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertSubscription = async (
  id: string
): Promise<Subscription.Subscription[]> => {
  const subscription = await stripe.subscriptions.retrieve(id)
  return upsertSubscription(subscription)
}
