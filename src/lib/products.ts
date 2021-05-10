import Product from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { productSchema } from '../schemas/product'
import { constructUpsertSql } from '../utils/helpers'

const config = getConfig()

export const upsertProduct = async (product: Product.Product): Promise<Product.Product[]> => {
  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'products', productSchema)

  // Inject the values
  const prepared = sql(upsertString)(product)

  // Run it
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}

export const verifyProductExists = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    select id from "${config.SCHEMA}"."products" 
    where id = :id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

export const fetchAndInsertProduct = async (id: string): Promise<Product.Product[]> => {
  const product = await stripe.products.retrieve(id)
  return upsertProduct(product)
}
