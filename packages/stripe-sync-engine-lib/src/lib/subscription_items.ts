import Stripe from 'stripe'

import { pg as sql } from 'yesql'
import { subscriptionItemSchema } from '../schemas/subscription_item'
import { ConfigType } from '../types/types'
import { PostgresClient } from '../database/postgres'

export const upsertSubscriptionItems = async (
  subscriptionItems: Stripe.SubscriptionItem[],
  pgClient: PostgresClient
) => {
  const modifiedSubscriptionItems = subscriptionItems.map((subscriptionItem) => {
    // Modify price object to string id; reference prices table
    const priceId = subscriptionItem.price.id.toString()
    // deleted exists only on a deleted item
    const deleted = subscriptionItem.deleted
    // quantity not exist on volume tier item
    const quantity = subscriptionItem.quantity
    return {
      ...subscriptionItem,
      price: priceId,
      deleted: deleted ?? false,
      quantity: quantity ?? null,
    }
  })

  return pgClient.upsertMany(
    modifiedSubscriptionItems,
    'subscription_items',
    subscriptionItemSchema
  )
}

export const markDeletedSubscriptionItems = async (
  subscriptionId: string,
  currentSubItemIds: string[],
  pgClient: PostgresClient,
  config: ConfigType
): Promise<{ rowCount: number }> => {
  let prepared = sql(`
    select id from "${config.SCHEMA}"."subscription_items"
    where subscription = :subscriptionId and deleted = false;
    `)({ subscriptionId })
  const { rows } = await pgClient.query(prepared.text, prepared.values)
  const deletedIds = rows.filter(
    ({ id }: { id: string }) => currentSubItemIds.includes(id) === false
  )

  if (deletedIds.length > 0) {
    const ids = deletedIds.map(({ id }: { id: string }) => id)
    prepared = sql(`
      update "${config.SCHEMA}"."subscription_items"
      set deleted = true where id=any(:ids::text[]);
      `)({ ids })
    const { rowCount } = await pgClient.query(prepared.text, prepared.values)
    return { rowCount: rowCount || 0 }
  } else {
    return { rowCount: 0 }
  }
}
