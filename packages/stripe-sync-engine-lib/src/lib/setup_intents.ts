import Stripe from 'stripe'
import { setupIntentsSchema } from '../schemas/setup_intents'
import { backfillCustomers } from './customers'
import { PostgresClient } from '../database/postgres'
import { getUniqueIds } from '../database/utils'

export const upsertSetupIntents = async (
  setupIntents: Stripe.SetupIntent[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.SetupIntent[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(setupIntents, 'customer'), pgClient, stripe)
  }

  return pgClient.upsertMany(setupIntents, 'setup_intents', setupIntentsSchema)
}
