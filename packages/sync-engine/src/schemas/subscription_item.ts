import type { EntitySchema } from './types'

export const subscriptionItemSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'billing_thresholds',
    'created',
    'deleted',
    'metadata',
    'quantity',
    'price',
    'subscription',
    'tax_rates',
  ],
} as const
