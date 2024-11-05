import { JsonSchema } from '../types/types'

export const creditNoteSchema: JsonSchema = {
  $id: 'creditNoteSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    amount: { type: 'number' },
    amount_shipping: { type: 'number' },
    created: { type: 'number' },
    currency: { type: 'string' },
    customer: { type: 'string' },
    customer_balance_transaction: { type: 'string' },
    discount_amount: { type: 'number' },
    discount_amounts: { type: 'object' },
    invoice: { type: 'string' },
    lines: { type: 'object' },
    livemode: { type: 'boolean' },
    memo: { type: 'string' },
    metadata: { type: 'object' },
    number: { type: 'string' },
    out_of_band_amount: { type: 'number' },
    pdf: { type: 'string' },
    reason: { type: 'string' },
    refund: { type: 'string' },
    shipping_cost: { type: 'object' },
    status: { type: 'string' },
    subtotal: { type: 'number' },
    subtotal_excluding_tax: { type: 'number' },
    tax_amounts: { type: 'object' },
    total: { type: 'number' },
    total_excluding_tax: { type: 'number' },
    type: { type: 'string' },
    voided_at: { type: 'string' },
  },
  required: ['id'],
} as const