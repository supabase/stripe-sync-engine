import { getConfig } from '../utils/config'
import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { setupIntentsSchema } from '../schemas/setup_intents'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'

const config = getConfig()

export const upsertSetupIntents = async (
  setupIntents: Stripe.SetupIntent[]
): Promise<Stripe.SetupIntent[]> => {
  await backfillCustomers(getUniqueIds(setupIntents, 'customer'))

  return upsertMany(setupIntents, () =>
    constructUpsertSql(config.SCHEMA || 'stripe', 'setup_intents', setupIntentsSchema)
  )
}
