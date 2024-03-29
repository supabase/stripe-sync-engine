import { JsonSchema } from '../types/types'

export const paymentIntentSchema: JsonSchema = {
  $id: 'paymentIntentSchema',
  type: 'object',
  properties: {
    id: { type: 'text' },
    object: { type: 'text' },
    amount: { type: 'integer' },
    amount_capturable: { type: 'integer' },
    amount_details: { type: 'object' },
    amount_received: { type: 'integer' },
    application: { type: 'text' },
    application_fee_amount: { type: 'integer' },
    automatic_payment_methods: { type: 'text' },
    canceled_at: { type: 'integer' },
    cancellation_reason: { type: 'text' },
    capture_method: { type: 'text' },
    client_secret: { type: 'text' },
    confirmation_method: { type: 'text' },
    created: { type: 'integer' },
    currency: { type: 'text' },
    customer: { type: 'text' },
    description: { type: 'text' },
    invoice: { type: 'text' },
    last_payment_error: { type: 'text' },
    livemode: { type: 'boolean' },
    metadata: { type: 'object' },
    next_action: { type: 'text' },
    on_behalf_of: { type: 'text' },
    payment_method: { type: 'text' },
    payment_method_options: { type: 'object' },
    payment_method_types: { type: 'object' },
    processing: { type: 'text' },
    receipt_email: { type: 'text' },
    review: { type: 'text' },
    setup_future_usage: { type: 'text' },
    shipping: { type: 'object' },
    statement_descriptor: { type: 'text' },
    statement_descriptor_suffix: { type: 'text' },
    status: { type: 'text' },
    transfer_data: { type: 'object' },
    transfer_group: { type: 'text' },
  },
  required: ['id'],
} as const
