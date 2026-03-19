import type { EntitySchema } from './types'

export const setupIntentsSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'created',
    'customer',
    'description',
    'payment_method',
    'status',
    'usage',
    'cancellation_reason',
    'latest_attempt',
    'mandate',
    'single_use_mandate',
    'on_behalf_of',
  ],
} as const
