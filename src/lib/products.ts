import Product from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'

const config = getConfig()

export const upsertProduct = async (product: Product.Product): Promise<Product.Product[]> => {
  const prepared = sql(`
    insert into "${config.SCHEMA}"."products" (
      id,
      active,
      description,
      metadata,
      name,
      created,
      images,
      livemode,
      package_dimensions,
      shippable,
      statement_descriptor,
      unit_label,
      updated,
      url
    )
    values (
      :id,
      :active,
      :description,
      :metadata,
      :name,
      :created,
      :images,
      :livemode,
      :package_dimensions,
      :shippable,
      :statement_descriptor,
      :unit_label,
      :updated,
      :url
    )
    on conflict(
      id
    )
    do update set 
      id = :id,
      active = :active,
      description = :description,
      metadata = :metadata,
      name = :name,
      created = :created,
      images = :images,
      livemode = :livemode,
      package_dimensions = :package_dimensions,
      shippable = :shippable,
      statement_descriptor = :statement_descriptor,
      unit_label = :unit_label,
      updated = :updated,
      url = :url;
    `)(product)
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}
