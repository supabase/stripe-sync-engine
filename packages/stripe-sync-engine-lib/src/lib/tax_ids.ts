import Stripe from 'stripe'
import { constructUpsertSql } from '../utils/helpers'
import { backfillCustomers } from './customers'
import { getUniqueIds, upsertMany } from './database_utils'
import { taxIdSchema } from '../schemas/tax_id'
import { pg as sql } from 'yesql'
import { query } from '../utils/PostgresConnection'
import { ConfigType } from '../types/types'

export const upsertTaxIds = async (
  taxIds: Stripe.TaxId[],
  config: ConfigType,
  backfillRelatedEntities: boolean = true
): Promise<Stripe.TaxId[]> => {
  if (backfillRelatedEntities) {
    await backfillCustomers(getUniqueIds(taxIds, 'customer'), config)
  }

  return upsertMany(
    taxIds,
    () => constructUpsertSql(config.SCHEMA, 'tax_ids', taxIdSchema),
    config.DATABASE_URL
  )
}

export const deleteTaxId = async (id: string, config: ConfigType): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."tax_ids" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, config.DATABASE_URL, prepared.values)
  return rows.length > 0
}
