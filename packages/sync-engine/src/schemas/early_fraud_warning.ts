import type { EntitySchema } from './types'

export const earlyFraudWarningSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'actionable',
    'charge',
    'created',
    'fraud_type',
    'livemode',
    'payment_intent',
  ],
} as const
