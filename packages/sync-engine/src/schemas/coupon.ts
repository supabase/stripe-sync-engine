import type { EntitySchema } from './types'

export const couponSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'name',
    'valid',
    'created',
    'currency',
    'duration',
    'livemode',
    'metadata',
    'redeem_by',
    'amount_off',
    'percent_off',
    'times_redeemed',
    'max_redemptions',
    'duration_in_months',
    'percent_off_precise',
  ],
} as const