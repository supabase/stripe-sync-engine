import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { setupIntentsSchema } from '../schemas/setup_intents'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'
import { ConfigType } from '../types/types'

export const upsertSetupIntents = async (
  setupIntents: Stripe.SetupIntent[],
  backfillRelatedEntities: boolean = true,
  config: ConfigType
): Promise<Stripe.SetupIntent[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(setupIntents, 'customer'), config)
  }

  return upsertMany(
    setupIntents,
    () => constructUpsertSql(config.SCHEMA, 'setup_intents', setupIntentsSchema),
    config.DATABASE_URL
  )
}
