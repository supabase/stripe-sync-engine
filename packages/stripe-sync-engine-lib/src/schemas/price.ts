import { JsonSchema } from '../types/types'

export const priceSchema: JsonSchema = {
  $id: 'priceSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    active: { type: 'boolean' },
    currency: { type: 'string' },
    metadata: { type: 'object' },
    nickname: { type: 'string' },
    recurring: { type: 'object' },
    type: { type: 'string' },
    unit_amount: { type: 'integer' },
    billing_scheme: { type: 'string' },
    created: { type: 'integer' },
    livemode: { type: 'boolean' },
    lookup_key: { type: 'string' },
    tiers_mode: { type: 'string' },
    transform_quantity: { type: 'object' },
    unit_amount_decimal: { type: 'string' },
    product: { type: 'string' },
  },
  required: ['id'],
} as const
