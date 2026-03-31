import type {
  ConfiguredCatalog,
  ConnectorSpecification,
  Message,
  Source,
} from '@stripe/sync-protocol'
import Stripe from 'stripe'
import { z } from 'zod'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromRegistry, catalogFromOpenApi } from './catalog.js'
import {
  resolveOpenApiSpec,
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from '@stripe/sync-openapi'
import { processStripeEvent } from './process-event.js'
import { processWebhookInput, createInputQueue, startWebhookServer } from './src-webhook.js'
import { listApiBackfill } from './src-list-api.js'
import { pollEvents } from './src-events-api.js'
import type { StripeWebSocketClient, StripeWebhookEvent } from './src-websocket.js'
import { createStripeWebSocketClient } from './src-websocket.js'
import type { ResourceConfig } from './types.js'
import { makeClient } from './client.js'
import type { RateLimiter } from './rate-limiter.js'
import { createInMemoryRateLimiter, DEFAULT_MAX_RPS } from './rate-limiter.js'

// MARK: - Spec

export const spec = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  livemode: z.boolean().optional().describe('Whether this is a live mode sync'),
  api_version: z.string().optional().describe('Stripe API version (e.g. 2025-04-30.basil)'),
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
  rate_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max Stripe API requests per second (default: 25)'),
  backfill_concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of time-range segments for parallel backfill (default: 200)'),
})

export type Config = z.infer<typeof spec>

/** Raw webhook payload requiring signature verification. */
export type WebhookInput = {
  body: string | Buffer
  headers: Record<string, string | string[] | undefined>
}

// MARK: - Stream state

export type SegmentState = {
  index: number
  gte: number
  lt: number
  pageCursor: string | null
  status: 'pending' | 'complete'
}

export type StripeStreamState = {
  pageCursor: string | null
  status: 'pending' | 'complete'
  events_cursor?: number
  segments?: SegmentState[]
}

const segmentStateSpec = z.object({
  index: z.number(),
  gte: z.number(),
  lt: z.number(),
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
})

const streamStateSpec = z.object({
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
  events_cursor: z.number().optional(),
  segments: z.array(segmentStateSpec).optional(),
})

// MARK: - Source

export type StripeSourceDeps = {
  rateLimiter?: RateLimiter
}

export function createStripeSource(
  deps?: StripeSourceDeps
): Source<Config, StripeStreamState, WebhookInput | Stripe.Event> {
  const externalRateLimiter = deps?.rateLimiter

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
      const resolved = await resolveOpenApiSpec({
        apiVersion: config.api_version ?? '2020-08-27',
      })
      const registry = buildResourceRegistry(
        resolved.spec,
        config.api_key,
        resolved.apiVersion,
        config.base_url
      )
      try {
        const parser = new SpecParser()
        const parsed = parser.parse(resolved.spec, {
          resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
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
          // Tradeoff: we subscribe to all events ('*') rather than only the
          // events needed by this sync's catalog. This is not ideal — Stripe
          // will send events we don't need, adding unnecessary network traffic.
          // However, Stripe accounts have a hard limit on webhook endpoints
          // (~16 per account), and scoping events per-sync would require one
          // endpoint per sync. By sharing a single endpoint across all syncs
          // for the same account, each sync filters events by its own catalog
          // inside processStripeEvent(), keeping endpoint usage constant
          // regardless of how many syncs are configured.
          await stripe.webhookEndpoints.create({
            url: config.webhook_url,
            enabled_events: ['*'],
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
      const rateLimiter =
        externalRateLimiter ?? createInMemoryRateLimiter(config.rate_limit ?? DEFAULT_MAX_RPS)
      const stripe = makeClient(config)
      const resolved = await resolveOpenApiSpec({
        apiVersion: config.api_version ?? '2020-08-27',
      })
      const registry = buildResourceRegistry(
        resolved.spec,
        config.api_key,
        resolved.apiVersion,
        config.base_url
      )
      const streamNames = new Set(catalog.streams.map((s) => s.stream.name))

      // Event-driven mode: iterate over incoming webhook inputs
      if ($stdin) {
        for await (const input of $stdin) {
          if ('body' in (input as object)) {
            yield* processWebhookInput(
              input as WebhookInput,
              config,
              stripe,
              catalog,
              registry,
              streamNames
            )
          } else {
            yield* processStripeEvent(
              input as Stripe.Event,
              config,
              stripe,
              catalog,
              registry,
              streamNames
            )
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
          stripe,
          rateLimiter,
          backfillLimit: config.backfill_limit,
          backfillConcurrency: config.backfill_concurrency,
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
                yield* processStripeEvent(
                  queued.data,
                  config,
                  stripe,
                  catalog,
                  registry,
                  streamNames
                )
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
  }
}

export default createStripeSource()

// MARK: - Re-exports

export { buildResourceRegistry, DEFAULT_SYNC_OBJECTS } from './resourceRegistry.js'
export { catalogFromRegistry } from './catalog.js'
export { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from './openapi/specParser.js'
export type { ParsedResourceTable, ParsedOpenApiSpec } from './openapi/types.js'
export type { RateLimiter } from './rate-limiter.js'
export { createInMemoryRateLimiter, DEFAULT_MAX_RPS } from './rate-limiter.js'
