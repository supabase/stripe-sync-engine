import Subscription from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { subscriptionSchema } from '../schemas/subscription'
import { verifyCustomerExists, fetchAndInsertCustomer } from './customers'
import { upsertSubscriptionItem } from './subscription_items'

const config = getConfig()

export const upsertSubscription = async (
  subscription: Subscription.Subscription
): Promise<Subscription.Subscription[]> => {
  // Backfill customer if it doesn't already exist
  const customerId = subscription?.customer?.toString()
  if (customerId && !(await verifyCustomerExists(customerId))) {
    await fetchAndInsertCustomer(customerId)
  }

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

  // Upsert subscription items into a separate table
  // need to run after upsert subscription cos subscriptionItems will reference the subscription
  const subscriptionItems = subscription.items.data
  await Promise.all(subscriptionItems.map((x) => upsertSubscriptionItem(x)))

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

type fetchSubscriptionsResponse = Subscription.Response<
  Subscription.ApiList<Subscription.Subscription>
>
type fetchSubscriptionsParams = {
  limit: number
}
const fetchSubscriptionsDefaults = {
  limit: 20,
}
export const fetchSubscriptions = async (
  options: fetchSubscriptionsParams = fetchSubscriptionsDefaults
): Promise<fetchSubscriptionsResponse> => {
  const subscriptions = await stripe.subscriptions.list({
    limit: options.limit,
  })
  return subscriptions
}
