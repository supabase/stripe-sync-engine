import { JsonSchema } from '../types/types'

export const customerSchema: JsonSchema = {
  $id: 'customerSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    address: { type: 'object' },
    description: { type: 'string' },
    email: { type: 'string' },
    metadata: { type: 'object' },
    name: { type: 'string' },
    phone: { type: 'string' },
    shipping: { type: 'object' },
    balance: { type: 'integer' },
    created: { type: 'integer' },
    currency: { type: 'string' },
    default_source: { type: 'string' },
    delinquent: { type: 'boolean' },
    discount: { type: 'object' },
    invoice_prefix: { type: 'string' },
    invoice_settings: { type: 'object' },
    livemode: { type: 'boolean' },
    next_invoice_sequence: { type: 'integer' },
    preferred_locales: { type: 'object' },
    tax_exempt: { type: 'boolean' },
  },
  required: ['id'],
} as const

export const customerDeletedSchema: JsonSchema = {
  $id: 'customerSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    deleted: { type: 'boolean' },
  },
  required: ['id'],
} as const
