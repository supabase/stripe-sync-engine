import Customer from 'stripe'
import { query } from '../utils/PostgresConnection'
import { pg as sql } from 'yesql'
import { getConfig } from '../utils/config'

const config = getConfig()

export const upsertCustomer = async (customer: Customer): Promise<Customer[]> => {
  const prepared = sql(`
    insert into "${config.SCHEMA}"."customers" (
      id,
      address,
      description,
      email,
      metadata,
      name,
      phone,
      shipping,
      balance,
      created,
      currency,
      default_source,
      delinquent,
      discount,
      invoice_prefix,
      invoice_settings,
      livemode,
      next_invoice_sequence,
      preferred_locales,
      tax_exempt
    )
    values (
      :id,
      :address,
      :description,
      :email,
      :metadata,
      :name,
      :phone,
      :shipping,
      :balance,
      :created,
      :currency,
      :default_source,
      :delinquent,
      :discount,
      :invoice_prefix,
      :invoice_settings,
      :livemode,
      :next_invoice_sequence,
      :preferred_locales,
      :tax_exempt
    )
    on conflict(
      id
    )
    do update set 
      id = :id,
      address = :address,
      description = :description,
      email = :email,
      metadata = :metadata,
      name = :name,
      phone = :phone,
      shipping = :shipping,
      balance = :balance,
      created = :created,
      currency = :currency,
      default_source = :default_source,
      delinquent = :delinquent,
      discount = :discount,
      invoice_prefix = :invoice_prefix,
      invoice_settings = :invoice_settings,
      livemode = :livemode,
      next_invoice_sequence = :next_invoice_sequence,
      preferred_locales = :preferred_locales,
      tax_exempt = :tax_exempt;
    `)(customer)
  const { rows } = await query(prepared.text, prepared.values)
  return rows
}
