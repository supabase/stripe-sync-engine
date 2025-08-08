import type { EntitySchema } from './types'

export const featureSchema: EntitySchema = {
  properties: ['id', 'object', 'livemode', 'name', 'lookup_key', 'active', 'metadata'],
} as const
