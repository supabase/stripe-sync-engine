import type { EntitySchema } from './types'

export const priceSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'active',
    'currency',
    'metadata',
    'nickname',
    'recurring',
    'type',
    'unit_amount',
    'billing_scheme',
    'created',
    'livemode',
    'lookup_key',
    'tiers_mode',
    'transform_quantity',
    'unit_amount_decimal',
    'product',
  ],
} as const
