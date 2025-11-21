import type { EntitySchema } from './types'

export const managedWebhookSchema: EntitySchema = {
  properties: [
    'id',
    'object',
    'url',
    'enabled_events',
    'description',
    'enabled',
    'livemode',
    'metadata',
    'secret',
    'status',
    'api_version',
    'created',
  ],
} as const
