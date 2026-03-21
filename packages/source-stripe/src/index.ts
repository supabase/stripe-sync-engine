import type { ConfiguredCatalog, ConnectorSpecification, Message, Source } from '@stripe/protocol'
import Stripe from 'stripe'
import { z } from 'zod'
import { buildResourceRegistry } from './resourceRegistry'
import { catalogFromRegistry, catalogFromOpenApi } from './catalog'
import { resolveOpenApiSpec } from './openapi/specFetchHelper'
import {
  SpecParser,
  RUNTIME_REQUIRED_TABLES,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from './openapi/specParser'
import { processStripeEvent } from './process-event'
import { processWebhookInput, createInputQueue, startWebhookServer } from './src-webhook'
import { listApiBackfill } from './src-list-api'
import { pollEvents } from './src-events-api'
import type { StripeWebSocketClient, StripeWebhookEvent } from './src-websocket'
import { createStripeWebSocketClient } from './src-websocket'
import type { ResourceConfig } from './types'

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
  poll_events: z
    .boolean()
    .optional()
    .describe('Enable events API polling for incremental sync after backfill'),
  webhook_port: z
    .number()
    .int()
    .optional()
    .describe('Port for built-in webhook HTTP listener (e.g. 4242)'),
  revalidate_objects: z
    .array(z.string())
    .optional()
    .describe('Object types to re-fetch from Stripe API on webhook (e.g. ["subscription"])'),
  backfill_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max objects to backfill per stream (useful for testing)'),
})

export type Config = z.infer<typeof spec>

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

/** Raw webhook payload requiring signature verification. */
export type WebhookInput = { body: string | Buffer; signature: string }

// MARK: - Stream state

export type StripeStreamState = {
  pageCursor: string | null
  status: 'pending' | 'complete'
  events_cursor?: number
}

const streamStateSpec = z.object({
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
  events_cursor: z.number().optional(),
})

// MARK: - Source

const source = {
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
    const registry = buildResourceRegistry(makeClient(config))
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
  },

  async *read({ config, catalog, state }, $stdin?) {
    const registry = buildResourceRegistry(makeClient(config))
    const stripe = makeClient(config)
    const streamNames = new Set(catalog.streams.map((s) => s.stream.name))

    // Event-driven mode: iterate over incoming webhook inputs
    if ($stdin) {
      for await (const input of $stdin) {
        if ('body' in input) {
          yield* processWebhookInput(input, config, stripe, catalog, registry, streamNames)
        } else {
          yield* processStripeEvent(input, config, stripe, catalog, registry, streamNames)
        }
      }
      return
    }

    const inputQueue = createInputQueue()

    let wsClient: StripeWebSocketClient | null = null
    if (config.websocket) {
      wsClient = await createStripeWebSocketClient({
        stripeApiKey: config.api_key,
        onEvent: (wsEvent: StripeWebhookEvent) => {
          const event = JSON.parse(wsEvent.event_payload) as Stripe.Event
          inputQueue.push({ data: event })
        },
      })
    }

    let httpServer: ReturnType<typeof startWebhookServer> | null = null

    try {
      const startTimestamp = Math.floor(Date.now() / 1000)

      // Backfill: paginate through each configured stream
      yield* listApiBackfill({
        catalog,
        state,
        registry,
        backfillLimit: config.backfill_limit,
        drainQueue: wsClient
          ? () => inputQueue.drain(config, stripe, catalog, registry, streamNames)
          : undefined,
      })

      // Events polling: incremental sync via /v1/events after backfill
      yield* pollEvents({ config, stripe, catalog, registry, streamNames, state, startTimestamp })

      // Start HTTP server for live mode if configured
      if (config.webhook_port) {
        httpServer = startWebhookServer(config.webhook_port, inputQueue.push)
      }

      // After backfill: stream live events from WebSocket and/or HTTP
      if (wsClient || httpServer) {
        // Drain anything that arrived during backfill
        yield* inputQueue.drain(config, stripe, catalog, registry, streamNames)

        // Block on new events (infinite loop until all live sources close)
        while (wsClient || httpServer) {
          const queued = await inputQueue.wait()
          try {
            if ('body' in queued.data) {
              yield* processWebhookInput(
                queued.data,
                config,
                stripe,
                catalog,
                registry,
                streamNames
              )
            } else {
              yield* processStripeEvent(queued.data, config, stripe, catalog, registry, streamNames)
            }
            queued.resolve?.()
          } catch (err) {
            queued.reject?.(err instanceof Error ? err : new Error(String(err)))
          }
        }
      }
    } finally {
      if (wsClient) {
        wsClient.close()
        wsClient = null
      }
      if (httpServer) {
        httpServer.close()
        httpServer = null
      }
    }
  },
} satisfies Source<Config, StripeStreamState, WebhookInput | Stripe.Event>

export default source

// MARK: - Re-exports

// Source submodules
export { fromWebhookEvent, processStripeEvent } from './process-event'
export type { LiveInput } from './src-webhook'

// Types
export type {
  BaseResourceConfig,
  StripeListResourceConfig,
  ResourceConfig,
  Logger,
  RevalidateEntity,
} from './types'
export { SUPPORTED_WEBHOOK_EVENTS } from './types'
export type { Source } from '@stripe/protocol'

// Resource Registry
export {
  buildResourceRegistry,
  normalizeStripeObjectName,
  RUNTIME_REQUIRED_TABLES,
} from './resourceRegistry'

// WebSocket
export { createStripeWebSocketClient } from './src-websocket'
export type {
  StripeWebSocketClient,
  StripeWebSocketOptions,
  WebhookProcessingResult,
  WebhookResponse,
  StripeWebhookEvent,
} from './src-websocket'

// Catalog
export { catalogFromRegistry, catalogFromOpenApi } from './catalog'

// Transforms
export {
  backfillDependencies,
  expandLists,
  syncSubscriptionItems,
  upsertSubscriptionItems,
} from './transforms'

// Utils
export { expandEntity } from './utils/expandEntity'
export { hashApiKey } from './utils/hashApiKey'

// OpenAPI spec → JSON Schema
export type * from './openapi/types'
export {
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  RUNTIME_RESOURCE_ALIASES,
} from './openapi/specParser'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './openapi/runtimeMappings'
export { resolveOpenApiSpec } from './openapi/specFetchHelper'
export { parsedTableToJsonSchema } from './openapi/jsonSchemaConverter'
