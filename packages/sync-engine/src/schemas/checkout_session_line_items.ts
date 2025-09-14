import type { EntitySchema } from './types'

export const checkoutSessionLineItemSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'amount_discount',
    'amount_subtotal',
    'amount_tax',
    'amount_total',
    'currency',
    'description',
    'price',
    'quantity',
    'checkout_session',
  ],
} as const
