import type {
  ConnectorSpecification,
  ErrorMessage,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import Stripe from 'stripe'
import { z } from 'zod'
import type { ResourceConfig } from './types'
import { buildResourceRegistry, normalizeStripeObjectName } from './resourceRegistry'
import { catalogFromRegistry, catalogFromOpenApi } from './catalog'
import { resolveOpenApiSpec } from './openapi/specFetchHelper'
import {
  SpecParser,
  RUNTIME_REQUIRED_TABLES,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from './openapi/specParser'
import type { StripeWebSocketClient, StripeWebhookEvent } from './websocket-client'
import { createStripeWebSocketClient } from './websocket-client'

// MARK: - Spec

export const spec = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for stripe-mock)'),
  webhook_url: z
    .string()
    .url()
    .optional()
    .describe('URL for managed webhook endpoint registration'),
  webhook_secret: z
    .string()
    .optional()
    .describe('Webhook signing secret (whsec_...) for signature verification'),
  websocket: z.boolean().optional().describe('Enable WebSocket streaming for live events'),
  revalidate_objects: z
    .array(z.string())
    .optional()
    .describe('Object types to re-fetch from Stripe API on webhook (e.g. ["subscription"])'),
})

export type Config = z.infer<typeof spec>

/** Raw webhook payload requiring signature verification. */
export type WebhookInput = { body: string | Buffer; signature: string }

// MARK: - Stream state

export type StripeStreamState = {
  pageCursor: string | null
  status: 'pending' | 'complete'
}

const streamStateSpec = z.object({
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
})

// MARK: - Helpers

function makeClient(config: Config): Stripe {
  if (config.base_url) {
    const url = new URL(config.base_url)
    return new Stripe(config.api_key, {
      host: url.hostname,
      port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
    })
  }
  return new Stripe(config.api_key)
}

function findConfigByTableName(
  registry: Record<string, ResourceConfig>,
  tableName: string
): ResourceConfig | undefined {
  return Object.values(registry).find((cfg) => cfg.tableName === tableName)
}

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

// MARK: - Source

export function createSource(
  _registryForTesting?: Record<string, ResourceConfig>
): Source<Config, StripeStreamState, WebhookInput | Stripe.Event> {
  function getRegistry(config: Config) {
    return _registryForTesting ?? buildResourceRegistry(makeClient(config))
  }

  // WebSocket closure state
  let wsClient: StripeWebSocketClient | null = null
  let eventWaiter: ((event: Stripe.Event) => void) | null = null
  const eventQueue: Stripe.Event[] = []

  function pushEvent(event: Stripe.Event) {
    if (eventWaiter) {
      const waiter = eventWaiter
      eventWaiter = null
      waiter(event)
    } else {
      eventQueue.push(event)
    }
  }

  function waitForEvent(): Promise<Stripe.Event> {
    return new Promise<Stripe.Event>((resolve) => {
      eventWaiter = resolve
    })
  }

  return {
    spec(): ConnectorSpecification {
      return {
        config: z.toJSONSchema(spec),
        stream_state: z.toJSONSchema(streamStateSpec),
      }
    },

    async check({ config }) {
      try {
        const s = makeClient(config)
        await s.accounts.retrieve()
        return { status: 'succeeded' }
      } catch (err: any) {
        return { status: 'failed', message: err.message }
      }
    },

    async discover({ config }) {
      const registry = getRegistry(config)
      try {
        const resolved = await resolveOpenApiSpec({ apiVersion: '2020-08-27' })
        const parser = new SpecParser()
        const parsed = parser.parse(resolved.spec, {
          resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
          allowedTables: [...RUNTIME_REQUIRED_TABLES],
        })
        return catalogFromOpenApi(parsed.tables, registry)
      } catch {
        return catalogFromRegistry(registry)
      }
    },

    async setup({ config, catalog }) {
      if (config.webhook_url) {
        const stripe = makeClient(config)
        const existing = await stripe.webhookEndpoints.list({ limit: 100 })
        const managed = existing.data.find(
          (wh) => wh.url === config.webhook_url && wh.metadata?.managed_by === 'stripe-sync'
        )
        if (!(managed && managed.status === 'enabled')) {
          await stripe.webhookEndpoints.create({
            url: config.webhook_url,
            enabled_events: catalog.streams.map(
              (s) => `${s.stream.name}.*` as Stripe.WebhookEndpointCreateParams.EnabledEvent
            ),
            metadata: { managed_by: 'stripe-sync' },
          })
        }
      }

      if (config.websocket) {
        wsClient = await createStripeWebSocketClient({
          stripeApiKey: config.api_key,
          onEvent: (wsEvent: StripeWebhookEvent) => {
            const event = JSON.parse(wsEvent.event_payload) as Stripe.Event
            pushEvent(event)
          },
        })
      }
    },

    async teardown({ config }) {
      if (config.webhook_url) {
        const stripe = makeClient(config)
        const existing = await stripe.webhookEndpoints.list({ limit: 100 })
        for (const wh of existing.data) {
          if (wh.metadata?.managed_by === 'stripe-sync') {
            await stripe.webhookEndpoints.del(wh.id)
          }
        }
      }

      if (wsClient) {
        wsClient.close()
        wsClient = null
      }
    },

    async *read({ config, catalog, state, input }) {
      const registry = getRegistry(config)

      // Live mode: process a single webhook event (full pipeline)
      if (input) {
        const stripe = makeClient(config)
        const streamNames = new Set(catalog.streams.map((s) => s.stream.name))

        // 1. Verify & parse: raw webhook (body+signature) or pre-parsed event
        let event: Stripe.Event
        if ('body' in input && 'signature' in input) {
          if (!config.webhook_secret) {
            throw new Error('webhook_secret is required for raw webhook signature verification')
          }
          event = await stripe.webhooks.constructEvent(
            input.body,
            input.signature,
            config.webhook_secret
          )
        } else {
          event = input
        }

        // 2. Extract object
        const dataObject = event.data?.object as unknown as
          | { id?: string; object?: string; deleted?: boolean; [key: string]: unknown }
          | undefined
        if (!dataObject?.object) return

        // 3. Entitlements special case — the summary object type doesn't map to a
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

        // 4. Filter by registry and catalog
        const objectType = normalizeStripeObjectName(dataObject.object)
        const resourceConfig = registry[objectType]
        if (!resourceConfig) return
        if (!dataObject.id) return // skip preview/draft objects
        if (!streamNames.has(resourceConfig.tableName)) return

        // 5. Delete events — yield record with deleted: true
        if (isDeleteEvent(event)) {
          yield toRecordMessage(resourceConfig.tableName, { ...dataObject, deleted: true })
          yield {
            type: 'state',
            stream: resourceConfig.tableName,
            data: { eventId: event.id, eventCreated: event.created },
          } satisfies StateMessage
          return
        }

        // 6. Revalidation — re-fetch from Stripe API if configured
        let data: Record<string, unknown> = dataObject
        if (
          config.revalidate_objects?.includes(objectType) &&
          resourceConfig.isFinalState &&
          !resourceConfig.isFinalState(dataObject)
        ) {
          data = (await resourceConfig.retrieveFn(dataObject.id)) as Record<string, unknown>
        }

        // 7. Yield main record
        yield toRecordMessage(resourceConfig.tableName, data)

        // 8. Yield subscription items if applicable
        if (
          objectType === 'subscription' &&
          (data as { items?: { data?: unknown[] } }).items?.data
        ) {
          for (const item of (data as { items: { data: Record<string, unknown>[] } }).items.data) {
            yield toRecordMessage('subscription_items', item)
          }
        }

        yield {
          type: 'state',
          stream: resourceConfig.tableName,
          data: { eventId: event.id, eventCreated: event.created },
        } satisfies StateMessage
        return
      }

      const streamNames = new Set(catalog.streams.map((s) => s.stream.name))

      // Helper: yield all queued WebSocket events matching the catalog
      function* drainQueue(): Generator<Message> {
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          const result = fromWebhookEvent(event, registry)
          if (!result) continue
          if (!streamNames.has(result.record.stream)) continue
          yield result.record
          yield result.state
        }
      }

      // Backfill: paginate through each configured stream
      for (const configuredStream of catalog.streams) {
        const stream = configuredStream.stream
        const resourceConfig = findConfigByTableName(registry, stream.name)
        if (!resourceConfig) {
          yield {
            type: 'error',
            failure_type: 'config_error',
            message: `Unknown stream: ${stream.name}`,
            stream: stream.name,
          } satisfies ErrorMessage
          continue
        }

        yield {
          type: 'stream_status',
          stream: stream.name,
          status: 'started',
        } satisfies StreamStatusMessage

        // Restore cursor from combined state if available
        const streamState = state?.[stream.name]
        let pageCursor: string | null = streamState?.pageCursor ?? null

        try {
          let hasMore = true
          while (hasMore) {
            // Drain any queued WebSocket events before each page
            if (wsClient) yield* drainQueue()

            const params: { limit: number; starting_after?: string } = { limit: 100 }
            if (pageCursor) {
              params.starting_after = pageCursor
            }

            const response = await resourceConfig.listFn(params)

            for (const item of response.data) {
              yield toRecordMessage(stream.name, item as Record<string, unknown>)
            }

            hasMore = response.has_more
            if (response.data.length > 0) {
              pageCursor = (response.data[response.data.length - 1] as { id: string }).id
            }

            // Emit state checkpoint after each page
            yield {
              type: 'state',
              stream: stream.name,
              data: {
                pageCursor: hasMore ? pageCursor : null,
                status: hasMore ? 'pending' : 'complete',
              },
            } satisfies StateMessage
          }

          yield {
            type: 'stream_status',
            stream: stream.name,
            status: 'complete',
          } satisfies StreamStatusMessage
        } catch (err) {
          const isRateLimit = err instanceof Error && err.message.includes('Rate limit')
          yield {
            type: 'error',
            failure_type: isRateLimit ? 'transient_error' : 'system_error',
            message: String(err),
            stream: stream.name,
            ...(err instanceof Error ? { stack_trace: err.stack } : {}),
          } satisfies ErrorMessage
        }
      }

      // After backfill: stream WebSocket events indefinitely
      if (wsClient) {
        // Drain anything that arrived during the last page
        yield* drainQueue()

        // Block on new events (infinite loop until wsClient is closed)
        while (wsClient) {
          const event = await waitForEvent()
          const result = fromWebhookEvent(event, registry)
          if (!result) continue
          if (!streamNames.has(result.record.stream)) continue
          yield result.record
          yield result.state
        }
      }
    },
  }
}

const source = createSource()
export default source
