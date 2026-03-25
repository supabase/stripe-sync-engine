import type { ConfiguredCatalog, Message, RecordMessage, StateMessage } from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import type Stripe from 'stripe'
import type { Config } from './index.js'
import type { ResourceConfig } from './types.js'
import { normalizeStripeObjectName } from './resourceRegistry.js'

// MARK: - Delete event detection

const RESOURCE_DELETE_EVENTS: ReadonlySet<string> = new Set([
  'customer.deleted',
  'product.deleted',
  'price.deleted',
  'plan.deleted',
  'invoice.deleted',
  'coupon.deleted',
  'customer.tax_id.deleted',
])

function isDeleteEvent(event: Stripe.Event): boolean {
  if (
    'deleted' in event.data.object &&
    (event.data.object as { deleted?: boolean }).deleted === true
  ) {
    return true
  }
  return RESOURCE_DELETE_EVENTS.has(event.type)
}

// MARK: - fromWebhookEvent

/**
 * Convert a single Stripe webhook event into protocol messages.
 *
 * Returns { record, state } for supported events, or null if the event's
 * object type is not in the registry or the object has no id.
 *
 * This is the building block for live mode. The orchestrator/webhook server
 * pushes events in; this method converts them to protocol messages.
 */
export function fromWebhookEvent(
  event: Stripe.Event,
  registry: Record<string, ResourceConfig>
): { record: RecordMessage; state: StateMessage } | null {
  const dataObject = event.data?.object as unknown as
    | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
    | undefined
  if (!dataObject?.object) return null

  // Find config by matching registry keys to the Stripe object type
  const objectType = dataObject.object
  const config = registry[objectType]
  if (!config) return null

  // Skip objects without an id (preview/draft objects like invoice.upcoming)
  if (!dataObject.id) return null

  const record = toRecordMessage(config.tableName, dataObject as Record<string, unknown>)
  const state: StateMessage = {
    type: 'state',
    stream: config.tableName,
    data: {
      eventId: event.id,
      eventCreated: event.created,
    },
  }

  return { record, state }
}

// MARK: - processStripeEvent

/**
 * Process a single verified Stripe.Event through the full pipeline:
 * entitlements, registry filter, delete detection, revalidation,
 * subscription items.
 *
 * This is the canonical function — all event paths (webhook, events API,
 * WebSocket) converge here once a Stripe.Event is in hand.
 */
export async function* processStripeEvent(
  event: Stripe.Event,
  config: Config,
  stripe: Stripe,
  catalog: ConfiguredCatalog,
  registry: Record<string, ResourceConfig>,
  streamNames: Set<string>
): AsyncGenerator<Message> {
  // 1. Extract object
  const dataObject = event.data?.object as unknown as
    | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
    | undefined
  if (!dataObject?.object) return

  // 2. Entitlements special case — the summary object type doesn't map to a
  //    registry entry, so we must handle it before the registry lookup.
  if (event.type === 'entitlements.active_entitlement_summary.updated') {
    if (!streamNames.has('active_entitlements')) return
    const summary = dataObject as {
      customer: string
      entitlements: {
        data: Array<{
          id: string
          object: string
          feature: string | { id: string }
          livemode: boolean
          lookup_key: string
        }>
      }
    }
    for (const e of summary.entitlements.data) {
      yield toRecordMessage('active_entitlements', {
        id: e.id,
        object: e.object,
        feature: typeof e.feature === 'string' ? e.feature : e.feature.id,
        customer: summary.customer,
        livemode: e.livemode,
        lookup_key: e.lookup_key,
      })
    }
    yield {
      type: 'state',
      stream: 'active_entitlements',
      data: { eventId: event.id, eventCreated: event.created },
    } satisfies StateMessage
    return
  }

  // 3. Filter by registry and catalog
  const objectType = normalizeStripeObjectName(dataObject.object)
  const resourceConfig = registry[objectType]
  if (!resourceConfig) return
  if (!dataObject.id) return // skip preview/draft objects
  if (!streamNames.has(resourceConfig.tableName)) return

  // 4. Delete events — yield record with deleted: true
  if (isDeleteEvent(event)) {
    yield toRecordMessage(resourceConfig.tableName, { ...dataObject, deleted: true })
    yield {
      type: 'state',
      stream: resourceConfig.tableName,
      data: { eventId: event.id, eventCreated: event.created },
    } satisfies StateMessage
    return
  }

  // 5. Revalidation — re-fetch from Stripe API if configured
  let data: Record<string, unknown> = dataObject
  if (
    config.revalidate_objects?.includes(objectType) &&
    resourceConfig.isFinalState &&
    !resourceConfig.isFinalState(dataObject)
  ) {
    data = (await resourceConfig.retrieveFn(dataObject.id)) as Record<string, unknown>
  }

  // 6. Yield main record
  yield toRecordMessage(resourceConfig.tableName, data)

  // 7. Yield subscription items if applicable
  if (objectType === 'subscription' && (data as { items?: { data?: unknown[] } }).items?.data) {
    for (const item of (data as { items: { data: Record<string, unknown>[] } }).items.data) {
      yield toRecordMessage('subscription_items', item)
    }
  }

  yield {
    type: 'state',
    stream: resourceConfig.tableName,
    data: { eventId: event.id, eventCreated: event.created },
  } satisfies StateMessage
}
