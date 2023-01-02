import { JsonSchema } from '../types/types'

export const setupIntentsSchema: JsonSchema = {
  $id: 'setupIntentSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    created: { type: 'integer' },
    customer: { type: 'string' },
    description: { type: 'string' },
    payment_method: { type: 'string' },
    status: { type: 'string' },
    usage: { type: 'string' },
    cancellation_reason: { type: 'string' },
    latest_attempt: { type: 'string' },
    mandate: { type: 'string' },
    single_use_mandate: { type: 'string' },
    on_behalf_of: { type: 'string' },
  },
  required: ['id'],
} as const
