import Stripe from 'stripe'
import { backfillCustomers } from './customers'
import { taxIdSchema } from '../schemas/tax_id'
import { getUniqueIds } from '../database/utils'
import { PostgresClient } from '../database/postgres'

export const upsertTaxIds = async (
  taxIds: Stripe.TaxId[],
  pgClient: PostgresClient,
  stripe: Stripe,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.TaxId[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(taxIds, 'customer'), pgClient, stripe)
  }

  return pgClient.upsertMany(taxIds, 'tax_ids', taxIdSchema)
}

export const deleteTaxId = async (id: string, pgClient: PostgresClient): Promise<boolean> => {
  return pgClient.deleteOne('tax_ids', id)
}
