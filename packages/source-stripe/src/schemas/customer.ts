import type { EntitySchema } from './types'

export const customerSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'address',
    'description',
    'email',
    'metadata',
    'name',
    'phone',
    'shipping',
    'balance',
    'created',
    'currency',
    'default_source',
    'delinquent',
    'discount',
    'invoice_prefix',
    'invoice_settings',
    'livemode',
    'next_invoice_sequence',
    'preferred_locales',
    'tax_exempt',
  ],
} as const

export const customerDeletedSchema: EntitySchema = {
  properties: ['id', 'object', 'deleted'],
} as const
