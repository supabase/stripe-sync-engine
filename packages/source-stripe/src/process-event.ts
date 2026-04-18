import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceStateMessage,
} from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import type { StripeEvent } from './spec.js'
import type { Config } from './index.js'
import type { ResourceConfig } from './types.js'
import { normalizeStripeObjectName } from './resourceRegistry.js'

type EventState = { eventId: string; eventCreated: number }
const msg = createSourceMessageFactory<
  EventState,
  Record<string, unknown>,
  Record<string, unknown>
>()

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

function isDeleteEvent(event: StripeEvent): boolean {
  if (
    'deleted' in event.data.object &&
    (event.data.object as { deleted?: boolean }).deleted === true
  ) {
    return true
  }
  return RESOURCE_DELETE_EVENTS.has(event.type)
}

// MARK: - fromStripeEvent

/**
 * Convert a single Stripe webhook event into protocol messages.
 *
 * Returns { record, state } for supported events, or null if the event's
 * object type is not in the registry or the object has no id.
 *
 * This is the building block for live mode. The orchestrator/webhook server
 * pushes events in; this method converts them to protocol messages.
 */
export function fromStripeEvent(
  event: StripeEvent,
  registry: Record<string, ResourceConfig>,
  accountId?: string
): { record: RecordMessage; state: SourceStateMessage } | null {
  const dataObject = event.data?.object as unknown as
    | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
    | undefined
  if (!dataObject?.object) return null

  const objectType = normalizeStripeObjectName(dataObject.object)
  const config = registry[objectType]
  if (!config) return null

  // Skip objects without an id (preview/draft objects like invoice.upcoming)
  if (!dataObject.id) return null

  const data = accountId
    ? { ...(dataObject as Record<string, unknown>), _account_id: accountId }
    : (dataObject as Record<string, unknown>)
  const record = msg.record({
    stream: config.tableName,
    data,
    emitted_at: new Date().toISOString(),
  })
  const state: SourceStateMessage = msg.source_state({
    state_type: 'stream',
    stream: config.tableName,
    data: {
      eventId: event.id,
      eventCreated: event.created,
    },
  })

  return { record, state }
}

// MARK: - processStripeEvent

/**
 * Process a single verified StripeEvent through the full pipeline:
 * entitlements, registry filter, delete detection, revalidation,
 * subscription items.
 *
 * This is the canonical function — all event paths (webhook, events API,
 * WebSocket) converge here once a StripeEvent is in hand.
 */
export async function* processStripeEvent(
  event: StripeEvent,
  config: Config,
  catalog: ConfiguredCatalog,
  registry: Record<string, ResourceConfig>,
  streamNames: Set<string>,
  accountId?: string
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
      yield msg.record({
        stream: 'active_entitlements',
        emitted_at: new Date().toISOString(),
        data: {
          id: e.id,
          object: e.object,
          feature: typeof e.feature === 'string' ? e.feature : e.feature.id,
          customer: summary.customer,
          livemode: e.livemode,
          lookup_key: e.lookup_key,
          ...(accountId ? { _account_id: accountId } : {}),
        },
      })
    }
    yield msg.source_state({
      state_type: 'stream',
      stream: 'active_entitlements',
      data: { eventId: event.id, eventCreated: event.created },
    })
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
    yield msg.record({
      stream: resourceConfig.tableName,
      emitted_at: new Date().toISOString(),
      data: {
        ...dataObject,
        deleted: true,
        ...(accountId ? { _account_id: accountId } : {}),
      },
    })
    yield msg.source_state({
      state_type: 'stream',
      stream: resourceConfig.tableName,
      data: { eventId: event.id, eventCreated: event.created },
    })
    return
  }

  // 5. Revalidation — re-fetch from Stripe API if configured
  let data: Record<string, unknown> = dataObject
  if (
    config.revalidate_objects?.some((r) => normalizeStripeObjectName(r) === objectType) &&
    resourceConfig.isFinalState &&
    !resourceConfig.isFinalState(dataObject)
  ) {
    data = (await resourceConfig.retrieveFn!(dataObject.id)) as Record<string, unknown>
  }

  // 6. Yield main record
  const recordData = accountId ? { ...data, _account_id: accountId } : data
  yield msg.record({
    stream: resourceConfig.tableName,
    data: recordData,
    emitted_at: new Date().toISOString(),
  })

  // 7. Yield subscription items if applicable
  if (objectType === 'subscriptions' && (data as { items?: { data?: unknown[] } }).items?.data) {
    for (const item of (data as { items: { data: Record<string, unknown>[] } }).items.data) {
      yield msg.record({
        stream: 'subscription_items',
        data: accountId ? { ...item, _account_id: accountId } : item,
        emitted_at: new Date().toISOString(),
      })
    }
  }

  yield msg.source_state({
    state_type: 'stream',
    stream: resourceConfig.tableName,
    data: { eventId: event.id, eventCreated: event.created },
  })
}
