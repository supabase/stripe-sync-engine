import type { EntitySchema } from './types'

export const productSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'active',
    'default_price',
    'description',
    'metadata',
    'name',
    'created',
    'images',
    'marketing_features',
    'livemode',
    'package_dimensions',
    'shippable',
    'statement_descriptor',
    'unit_label',
    'updated',
    'url',
  ],
} as const
