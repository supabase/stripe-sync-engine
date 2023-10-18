import { JsonSchema } from '../types/types'

export const subscriptionScheduleSchema: JsonSchema = {
  $id: 'subscriptionScheduleSchema',
  type: 'object',
  properties: {
    id: { type: 'string' },
    object: { type: 'string' },
    application: { type: 'string' },
    canceled_at: { type: 'number' },
    completed_at: { type: 'number' },
    created: { type: 'number' },
    current_phase: { type: 'object' },
    customer: { type: 'string' },
    default_settings: { type: 'object' },
    end_behavior: { type: 'string' },
    livemode: { type: 'boolean' },
    metadata: { type: 'object' },
    phases: { type: 'object' },
    released_at: { type: 'number' },
    released_subscription: { type: 'string' },
    status: { type: 'string' },
    subscription: { type: 'string' },
    test_clock: { type: 'string' },
  },
  required: ['id'],
} as const
