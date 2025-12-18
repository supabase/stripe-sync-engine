import { EntitySchema } from './types'

export const invoicePaymentSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'amount_paid',
    'amount_requested',
    'created',
    'currency',
    'invoice',
    'is_default',
    'livemode',
    'payment',
    'status',
    'status_transitions',
  ],
} as const
