import type { EntitySchema } from './types'

export const paymentMethodsSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'created',
    'customer',
    'type',
    'billing_details',
    'metadata',
    'card',
  ],
} as const
