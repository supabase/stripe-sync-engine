import { JsonSchema } from '../types/types'

export const paymentMethodsSchema: JsonSchema = {
  $id: 'paymentMethodSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    created: { type: 'integer' },
    customer: { type: 'string' },
    type: { type: 'string' },
    billing_details: { type: 'object' },
    metadata: { type: 'object' },
    card: { type: 'object' },
  },
  required: ['id'],
} as const
