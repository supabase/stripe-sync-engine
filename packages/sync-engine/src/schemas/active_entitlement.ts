import type { EntitySchema } from './types'

export const activeEntitlementSchema: EntitySchema = {
  properties: ['id', 'object', 'feature', 'lookup_key', 'livemode', 'customer'],
} as const
