import { backfillCustomers } from './customers'
import Stripe from 'stripe'
import { subscriptionScheduleSchema } from '../schemas/subscription_schedules'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'

export const upsertSubscriptionSchedules = async (
  subscriptionSchedules: Stripe.SubscriptionSchedule[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.SubscriptionSchedule[]> => {
  if (backfillRelatedEntities) {
    const customerIds = getUniqueIds(subscriptionSchedules, 'customer')

    await backfillCustomers(customerIds, pgClient, stripe)
  }

  // Run it
  return await pgClient.upsertMany(
    subscriptionSchedules,
    'subscription_schedules',
    subscriptionScheduleSchema
  )
}

export const backfillSubscriptionSchedules = async (
  subscriptionIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  const missingSubscriptionIds = await pgClient.findMissingEntries(
    'subscription_schedules',
    subscriptionIds
  )
  await fetchAndInsertSubscriptions(missingSubscriptionIds, pgClient, stripe)
}

const fetchAndInsertSubscriptions = async (
  subscriptionIds: string[],
  pgClient: PostgresClient,
  stripe: Stripe
) => {
  if (!subscriptionIds.length) return

  const subscriptionSchedules: Stripe.SubscriptionSchedule[] = []

  for (const subscriptionScheduleId of subscriptionIds) {
    const subscriptionSchedule = await stripe.subscriptionSchedules.retrieve(subscriptionScheduleId)
    subscriptionSchedules.push(subscriptionSchedule)
  }

  await upsertSubscriptionSchedules(subscriptionSchedules, pgClient, stripe)
}
