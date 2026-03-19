import type { EntitySchema } from './types'

export const reviewSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'billing_zip',
    'created',
    'charge',
    'closed_reason',
    'livemode',
    'ip_address',
    'ip_address_location',
    'open',
    'opened_reason',
    'payment_intent',
    'reason',
    'session',
  ],
} as const
