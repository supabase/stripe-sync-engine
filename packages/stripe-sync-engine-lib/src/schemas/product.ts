import { JsonSchema } from '../types/types'

export const productSchema: JsonSchema = {
  $id: 'productSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    active: { type: 'boolean' },
    description: { type: 'string' },
    metadata: { type: 'object' },
    name: { type: 'string' },
    created: { type: 'integer' },
    images: { type: 'object' },
    livemode: { type: 'boolean' },
    package_dimensions: { type: 'object' },
    shippable: { type: 'boolean' },
    statement_descriptor: { type: 'string' },
    unit_label: { type: 'string' },
    updated: { type: 'integer' },
    url: { type: 'string' },
  },
  required: ['id'],
} as const
