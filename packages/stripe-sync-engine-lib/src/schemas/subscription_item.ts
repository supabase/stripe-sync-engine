import { JsonSchema } from '../types/types'

export const subscriptionItemSchema: JsonSchema = {
  $id: 'subscriptionItemSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    billing_thresholds: { type: 'object' },
    created: { type: 'number' },
    deleted: { type: 'boolean' },
    metadata: { type: 'object' },
    quantity: { type: 'number' },
    price: { type: 'string' },
    subscription: { type: 'string' },
    tax_rates: { type: 'object' },
  },
  required: ['id'],
} as const
