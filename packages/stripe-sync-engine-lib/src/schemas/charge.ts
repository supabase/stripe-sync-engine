import { JsonSchema } from '../types/types'

export const chargeSchema: JsonSchema = {
  $id: 'chargeSchema',
  type: 'object',

  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    paid: { type: 'boolean' },
    order: { type: 'string' },
    amount: { type: 'number' },
    review: { type: 'string' },
    source: { type: 'object' },
    status: { type: 'string' },
    created: { type: 'number' },
    dispute: { type: 'string' },
    invoice: { type: 'string' },
    outcome: { type: 'object' },
    refunds: { type: 'object' },
    captured: { type: 'boolean' },
    currency: { type: 'string' },
    customer: { type: 'string' },
    livemode: { type: 'boolean' },
    metadata: { type: 'object' },
    refunded: { type: 'boolean' },
    shipping: { type: 'object' },
    application: { type: 'string' },
    description: { type: 'string' },
    destination: { type: 'string' },
    failure_code: { type: 'string' },
    on_behalf_of: { type: 'string' },
    fraud_details: { type: 'object' },
    receipt_email: { type: 'string' },
    payment_intent: { type: 'string' },
    receipt_number: { type: 'string' },
    transfer_group: { type: 'string' },
    amount_refunded: { type: 'number' },
    application_fee: { type: 'string' },
    failure_message: { type: 'string' },
    source_transfer: { type: 'string' },
    balance_transaction: { type: 'string' },
    statement_descriptor: { type: 'string' },
    payment_method_details: { type: 'object' },
  },
  required: ['id'],
} as const
