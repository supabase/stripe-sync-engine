import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { findMissingEntries, getUniqueIds, upsertMany } from './database_utils'
import Stripe from 'stripe'
import { subscriptionScheduleSchema } from '../schemas/subscription_schedules'
import { ConfigType } from '../types/types'
import { getStripe } from '../utils/StripeClientManager'

export const upsertSubscriptionSchedules = async (
  subscriptionSchedules: Stripe.SubscriptionSchedule[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.SubscriptionSchedule[]> => {
  if (backfillRelatedEntities) {
    const customerIds = getUniqueIds(subscriptionSchedules, 'customer')

    await backfillCustomers(customerIds, config)
  }

  // Run it
  const rows = await upsertMany(
    subscriptionSchedules,
    () => constructUpsertSql(config.SCHEMA, 'subscription_schedules', subscriptionScheduleSchema),
    config.DATABASE_URL
  )

  return rows
}

export const backfillSubscriptionSchedules = async (
  subscriptionIds: string[],
  config: ConfigType
) => {
  const missingSubscriptionIds = await findMissingEntries(
    'subscription_schedules',
    subscriptionIds,
    config
  )
  await fetchAndInsertSubscriptions(missingSubscriptionIds, config)
}

const fetchAndInsertSubscriptions = async (subscriptionIds: string[], config: ConfigType) => {
  if (!subscriptionIds.length) return

  const subscriptionSchedules: Stripe.SubscriptionSchedule[] = []

  for (const subscriptionScheduleId of subscriptionIds) {
    const subscriptionSchedule =
      await getStripe(config).subscriptionSchedules.retrieve(subscriptionScheduleId)
    subscriptionSchedules.push(subscriptionSchedule)
  }

  await upsertSubscriptionSchedules(subscriptionSchedules, config)
}
