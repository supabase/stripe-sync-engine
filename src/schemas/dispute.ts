import { JsonSchema } from '../types/types'

export const disputeSchema: JsonSchema = {
  $id: 'disputeSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    amount: { type: 'integer' },
    charge: { type: 'string' },
    created: { type: 'integer' },
    currency: { type: 'string' },
    balance_transactions: { type: 'object' },
    evidence: { type: 'object' },
    evidence_details: { type: 'object' },
    is_charge_refundable: { type: 'boolean' },
    livemode: { type: 'boolean' },
    metadata: { type: 'object' },
    payment_intent: { type: 'string' },
    reason: { type: 'string' },
    status: { type: 'string' },
  },
  required: ['id'],
} as const
