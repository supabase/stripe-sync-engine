import Subscription from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { constructUpsertSql } from '../utils/helpers'
import { subscriptionItemSchema } from '../schemas/subscription_item'

const config = getConfig()

export const upsertSubscriptionItem = async (
  subscriptionItem: Subscription.SubscriptionItem
): Promise<Subscription.Subscription[]> => {
  // Modify price object to string id; reference prices table
  const priceId = subscriptionItem.price.id.toString()
  const deleted = subscriptionItem.deleted
  const modifiedSubscriptionItem = {
    ...subscriptionItem,
    price: priceId,
    deleted: deleted ?? false,
  }

  // Create the SQL
  const upsertString = constructUpsertSql(
    config.SCHEMA || 'stripe',
    'subscription_items',
    subscriptionItemSchema
  )

  // Inject the values
  const prepared = sql(upsertString)(modifiedSubscriptionItem)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifySubscriptionItemExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."subscription_items"
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertSubscriptionItem = async (
  id: string
): Promise<Subscription.Subscription[]> => {
  const subscriptionItem = await stripe.subscriptionItems.retrieve(id)
  return upsertSubscriptionItem(subscriptionItem)
}
