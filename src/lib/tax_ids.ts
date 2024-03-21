import Stripe from 'stripe'
import { getConfig } from '../utils/config'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'
import { taxIdSchema } from '../schemas/tax_id'
import { pg as sql } from 'yesql'
import { query } from '../utils/PostgresConnection'

const config = getConfig()

export const upsertTaxIds = async (
  taxIds: Stripe.TaxId[],
  backfillRelatedEntities: boolean = true
): Promise<Stripe.TaxId[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(taxIds, 'customer'))
  }

  return upsertMany(taxIds, () => constructUpsertSql(config.SCHEMA, 'tax_ids', taxIdSchema))
}

export const deleteTaxId = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."tax_ids" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}
