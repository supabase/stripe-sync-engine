import Product from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'
import { stripe } from '../utils/StripeClientManager'
import { productSchema } from '../schemas/product'
import { cleanseArrayField, constructUpsertSql } from '../utils/helpers'

const config = getConfig()

export const upsertProduct = async (product: Product.Product): Promise<Product.Product[]> => {
  // Create the SQL
  const upsertString = constructUpsertSql(config.SCHEMA || 'stripe', 'products', productSchema)

  // Inject the values
  const cleansed = cleanseArrayField(product)
  const prepared = sql(upsertString)(cleansed)

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

export const deleteProduct = async (id: string): Promise<boolean> => {
  const prepared = sql(`
    delete from "${config.SCHEMA}"."products" 
    where id = :id
    returning id;
    `)({ id })
  const { rows } = await query(prepared.text, prepared.values)
  return rows.length > 0
}

type fetchProductsResponse = Product.Response<Product.ApiList<Product.Product>>
type fetchProductsParams = {
  limit: number
  id: string | undefined
}
const fetchProductsDefaults = {
  limit: 100,
  id: undefined,
}
export const fetchProducts = async (
  options: fetchProductsParams = fetchProductsDefaults
): Promise<fetchProductsResponse> => {
  const products = await stripe.products.list({
    limit: options.limit,
  })
  return products
}
