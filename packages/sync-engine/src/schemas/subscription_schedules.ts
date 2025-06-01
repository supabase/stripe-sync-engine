import type { EntitySchema } from './types'

export const subscriptionScheduleSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'application',
    'canceled_at',
    'completed_at',
    'created',
    'current_phase',
    'customer',
    'default_settings',
    'end_behavior',
    'livemode',
    'metadata',
    'phases',
    'released_at',
    'released_subscription',
    'status',
    'subscription',
    'test_clock',
  ],
} as const
