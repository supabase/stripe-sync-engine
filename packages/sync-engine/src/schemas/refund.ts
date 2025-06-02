import type { EntitySchema } from './types'

export const refundSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'amount',
    'balance_transaction',
    'charge',
    'created',
    'currency',
    'destination_details',
    'metadata',
    'payment_intent',
    'reason',
    'receipt_number',
    'source_transfer_reversal',
    'status',
    'transfer_reversal',
  ],
} as const
