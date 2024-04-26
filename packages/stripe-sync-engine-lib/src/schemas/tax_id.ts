import { JsonSchema } from '../types/types'

export const taxIdSchema: JsonSchema = {
  $id: 'taxIdSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    country: { type: 'string' },
    customer: { type: 'string' },
    type: { type: 'string' },
    value: { type: 'string' },
    object: { type: 'string' },
    created: { type: 'integer' },
    livemode: { type: 'boolean' },
    owner: { type: 'object' },
  },
  required: ['id'],
} as const
