import type { EntitySchema } from './types'

export const checkoutSessionLineItemSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'adjustable_quantity',
    'amount_subtotal',
    'amount_total',
    'currency',
    'description',
    'discounts',
    'price',
    'quantity',
    'taxes',
    'checkout_session',
  ],
} as const
