import Stripe from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { cleanseArrayField, constructUpsertSql } from '../utils/helpers'
import { upsertCharge } from './charges'
import { disputeSchema } from '../schemas/dispute'

const config = getConfig()

export const upsertDispute = async (charge: Stripe.Dispute): Promise<Stripe.Dispute[]> => {
  // Backfill charge if it doesn't already exist
  const chargeId = charge?.charge?.toString()
  if (chargeId && !(await verifyChargeExists(chargeId))) {
    await fetchAndInsertCharge(chargeId)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'disputes', disputeSchema)

  // Inject the values
  const cleansed = cleanseArrayField(charge)
  const prepared = sql(upsertString)(cleansed)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifyChargeExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."charges" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertCharge = async (id: string): Promise<Stripe.Charge[]> => {
  const charge = await stripe.charges.retrieve(id)
  return upsertCharge(charge)
}
