import type { EntitySchema } from './types'

export const disputeSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'amount',
    'charge',
    'created',
    'currency',
    'balance_transactions',
    'evidence',
    'evidence_details',
    'is_charge_refundable',
    'livemode',
    'metadata',
    'payment_intent',
    'reason',
    'status',
  ],
} as const
