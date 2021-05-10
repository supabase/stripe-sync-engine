import Price from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { verifyProductExists, fetchAndInsertProduct } from './products'
import { constructUpsertSql } from '../utils/helpers'
import { priceSchema } from '../schemas/price'

const config = getConfig()

export const upsertPrice = async (price: Price.Price): Promise<Price.Price[]> => {
  // Backfill product if it doesn't already exist
  const product_id = price.product.toString()
  if (price.product && !(await verifyProductExists(product_id))) {
    await fetchAndInsertProduct(product_id)
  }

  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'prices', priceSchema)

  // Inject the values
  const prepared = sql(upsertString)(price)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}
