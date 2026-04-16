type SubscriptionItem = {
  id: string
  price: { id: string } | string
  deleted?: boolean
  quantity?: number | null
  [key: string]: unknown
}

type Subscription = {
  id: string
  items: { data: SubscriptionItem[] }
  [key: string]: unknown
}

export async function syncSubscriptionItems(opts: {
  subscriptions: Subscription[]
  accountId: string
  syncTimestamp?: string
  upsertItems: (
    items: SubscriptionItem[],
    accountId: string,
    syncTimestamp?: string
  ) => Promise<void>
  markDeleted: (
    subscriptionId: string,
    currentSubItemIds: string[]
  ) => Promise<{ rowCount: number }>
}): Promise<void> {
  const subscriptionsWithItems = opts.subscriptions.filter((s) => s.items?.data)

  const allSubscriptionItems = subscriptionsWithItems.flatMap((s) => s.items.data)
  await opts.upsertItems(allSubscriptionItems, opts.accountId, opts.syncTimestamp)

  // Mark existing subscription items in db as deleted
  // if they don't exist in the current subscriptionItems list
  await Promise.all(
    subscriptionsWithItems.map((subscription) => {
      const subItemIds = subscription.items.data.map((x) => x.id)
      return opts.markDeleted(subscription.id, subItemIds)
    })
  )
}

export async function upsertSubscriptionItems(
  subscriptionItems: SubscriptionItem[],
  accountId: string,
  upsertMany: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: Record<string, any>[],
    table: string,
    accountId: string,
    syncTimestamp?: string
  ) => Promise<unknown[]>,
  syncTimestamp?: string
): Promise<void> {
  const modifiedSubscriptionItems = subscriptionItems.map((subscriptionItem) => ({
    ...subscriptionItem,
    price:
      typeof subscriptionItem.price === 'string'
        ? subscriptionItem.price
        : subscriptionItem.price.id.toString(),
    deleted: subscriptionItem.deleted ?? false,
    quantity: subscriptionItem.quantity ?? null,
  }))

  await upsertMany(modifiedSubscriptionItems, 'subscription_items', accountId, syncTimestamp)
}
