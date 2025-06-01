import type { EntitySchema } from './types'

export const planSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'active',
    'amount',
    'created',
    'product',
    'currency',
    'interval',
    'livemode',
    'metadata',
    'nickname',
    'tiers_mode',
    'usage_type',
    'billing_scheme',
    'interval_count',
    'aggregate_usage',
    'transform_usage',
    'trial_period_days',
  ],
} as const
