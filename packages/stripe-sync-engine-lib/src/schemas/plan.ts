import { JsonSchema } from '../types/types'

export const planSchema: JsonSchema = {
  $id: 'planSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    active: { type: 'boolean' },
    amount: { type: 'number' },
    created: { type: 'number' },
    product: { type: 'string' },
    currency: { type: 'string' },
    interval: { type: 'string' },
    livemode: { type: 'boolean' },
    metadata: { type: 'object' },
    nickname: { type: 'string' },
    tiers_mode: { type: 'string' },
    usage_type: { type: 'string' },
    billing_scheme: { type: 'string' },
    interval_count: { type: 'number' },
    aggregate_usage: { type: 'string' },
    transform_usage: { type: 'string' },
    trial_period_days: { type: 'number' },
  },
  required: ['id'],
} as const
