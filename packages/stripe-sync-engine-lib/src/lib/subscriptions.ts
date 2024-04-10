import { constructUpsertSql } from '../utils/helpers'
import { subscriptionSchema } from '../schemas/subscription'
import { backfillCustomers } from './customers'
import { markDeletedSubscriptionItems, upsertSubscriptionItems } from './subscription_items'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertSubscriptions = async (
  subscriptions: Stripe.Subscription[],
  backfillRelatedEntities: boolean = true,
  config: ConfigType
): Promise<Stripe.Subscription[]> => {
  if (backfillRelatedEntities) {
    const customerIds = getUniqueIds(subscriptions, 'customer')

    await backfillCustomers(customerIds, config)
  }

  // Stripe only sends the first 10 items by default, the option will actively fetch all items
  if (config.AUTO_EXPAND_LISTS) {
    for (const subscription of subscriptions) {
      if (subscription.items?.has_more) {
        const allItems: Stripe.SubscriptionItem[] = []
        for await (const item of getStripe(config).subscriptionItems.list({
          subscription: subscription.id,
          limit: 100,
        })) {
          allItems.push(item)
        }

        subscription.items = {
          ...subscription.items,
          data: allItems,
          has_more: false,
        }
      }
    }
  }

  // Run it
  const rows = await upsertMany(
    subscriptions,
    () => constructUpsertSql(config.SCHEMA, 'subscriptions', subscriptionSchema),
    config.DATABASE_URL
  )

  // Upsert subscription items into a separate table
  // need to run after upsert subscription cos subscriptionItems will reference the subscription
  const allSubscriptionItems = subscriptions.flatMap((subscription) => subscription.items.data)
  await upsertSubscriptionItems(allSubscriptionItems, config)

  // We have to mark existing subscription item in db as deleted
  // if it doesn't exist in current subscriptionItems list
  const markSubscriptionItemsDeleted: Promise<{ rowCount: number }>[] = []
  for (const subscription of subscriptions) {
    const subscriptionItems = subscription.items.data

    const subItemIds = subscriptionItems.map((x: Stripe.SubscriptionItem) => x.id)
    markSubscriptionItemsDeleted.push(
      markDeletedSubscriptionItems(subscription.id, subItemIds, config)
    )
  }
  await Promise.all(markSubscriptionItemsDeleted)

  return rows
}

export const backfillSubscriptions = async (subscriptionIds: string[], config: ConfigType) => {
  const missingSubscriptionIds = await findMissingEntries('subscriptions', subscriptionIds, config)
  await fetchAndInsertSubscriptions(missingSubscriptionIds, config)
}

const fetchAndInsertSubscriptions = async (subscriptionIds: string[], config: ConfigType) => {
  if (!subscriptionIds.length) return

  const subscriptions: Stripe.Subscription[] = []

  for (const subscriptionId of subscriptionIds) {
    const subscription = await getStripe(config).subscriptions.retrieve(subscriptionId)
    subscriptions.push(subscription)
  }

  await upsertSubscriptions(subscriptions, true, config)
}
