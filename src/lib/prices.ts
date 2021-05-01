import Price from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'

const config = getConfig()

export const upsertPrice = async (price: Price.Price): Promise<Price.Price[]> => {
  const prepared = sql(`
    insert into "${config.SCHEMA}"."prices" (
      id,
      active,
      currency,
      metadata,
      nickname,
      recurring,
      type,
      unit_amount,
      billing_scheme,
      created,
      livemode,
      lookup_key,
      tiers_mode,
      transform_quantity,
      unit_amount_decimal,
      product
    )
    values (
      :id,
      :active,
      :currency,
      :metadata,
      :nickname,
      :recurring,
      :type,
      :unit_amount,
      :billing_scheme,
      :created,
      :livemode,
      :lookup_key,
      :tiers_mode,
      :transform_quantity,
      :unit_amount_decimal,
      :product
    )
    on conflict(
      id
    )
    do update set 
      id = :id,
      active = :active,
      currency = :currency,
      metadata = :metadata,
      nickname = :nickname,
      recurring = :recurring,
      type = :type,
      unit_amount = :unit_amount,
      billing_scheme = :billing_scheme,
      created = :created,
      livemode = :livemode,
      lookup_key = :lookup_key,
      tiers_mode = :tiers_mode,
      transform_quantity = :transform_quantity,
      unit_amount_decimal = :unit_amount_decimal,
      product = :product;
    `)(price)
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}
