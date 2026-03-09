import type { EntitySchema } from './types'

export const promotionCodeSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'active',
    'code',
    'coupon',
    'created',
    'customer',
    'customer_account',
    'expires_at',
    'livemode',
    'max_redemptions',
    'metadata',
    'restrictions',
    'times_redeemed',
  ],
} as const