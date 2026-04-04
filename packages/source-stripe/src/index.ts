import type {
  ConfiguredCatalog,
  Message,
  Source,
  SpecOutput,
  CheckOutput,
  DiscoverOutput,
  SetupOutput,
  TeardownOutput,
} from '@stripe/sync-protocol'
import Stripe from 'stripe'
import { z } from 'zod'
import { configSchema } from './spec.js'
import type { Config } from './spec.js'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromRegistry, catalogFromOpenApi } from './catalog.js'
import {
  resolveOpenApiSpec,
  BUNDLED_API_VERSION,
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
import { fetchWithProxy } from './transport.js'

const apiFetch: typeof globalThis.fetch = (input, init) =>
  fetchWithProxy(input as URL | string, init ?? {})

// MARK: - Spec

export { configSchema, type Config } from './spec.js'

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

/** Compact backfill state — O(concurrency) not O(total segments). */
export type BackfillState = {
  range: { gte: number; lt: number }
  numSegments: number
  completed: Array<{ gte: number; lt: number }>
  inFlight: Array<{ gte: number; lt: number; pageCursor: string }>
}

export type StripeStreamState = {
  pageCursor: string | null
  status: 'pending' | 'complete'
  events_cursor?: number
  /** @deprecated Legacy — use backfill instead */
  segments?: SegmentState[]
  backfill?: BackfillState
}

const segmentStateSpec = z.object({
  index: z.number(),
  gte: z.number(),
  lt: z.number(),
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
})

const backfillStateSpec = z.object({
  range: z.object({ gte: z.number(), lt: z.number() }),
  numSegments: z.number(),
  completed: z.array(z.object({ gte: z.number(), lt: z.number() })),
  inFlight: z.array(z.object({ gte: z.number(), lt: z.number(), pageCursor: z.string() })),
})

const streamStateSpec = z.object({
  pageCursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
  events_cursor: z.number().optional(),
  segments: z.array(segmentStateSpec).optional(),
  backfill: backfillStateSpec.optional(),
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
    async *spec(): AsyncGenerator<SpecOutput> {
      yield {
        type: 'spec' as const,
        spec: {
          config: z.toJSONSchema(configSchema),
          stream_state: z.toJSONSchema(streamStateSpec),
        },
      }
    },

    async *check({ config }): AsyncGenerator<CheckOutput> {
      try {
        const s = makeClient(config)
        await s.accounts.retrieve()
        yield {
          type: 'connection_status' as const,
          connection_status: { status: 'succeeded' as const },
        }
      } catch (err: any) {
        yield {
          type: 'connection_status' as const,
          connection_status: { status: 'failed' as const, message: err.message },
        }
      }
    },

    async *discover({ config }): AsyncGenerator<DiscoverOutput> {
      const resolved = await resolveOpenApiSpec(
        { apiVersion: config.api_version ?? BUNDLED_API_VERSION },
        apiFetch
      )
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
        yield {
          type: 'catalog' as const,
          catalog: catalogFromOpenApi(parsed.tables, registry),
        }
      } catch {
        yield {
          type: 'catalog' as const,
          catalog: catalogFromRegistry(registry),
        }
      }
    },

    async *setup({ config, catalog }): AsyncGenerator<SetupOutput> {
      const updates: Partial<Config> = {}
      const stripe = makeClient(config)

      // Resolve account_id if not already set
      if (!config.account_id) {
        const account = await stripe.accounts.retrieve()
        updates.account_id = account.id
      }

      // Create managed webhook endpoint if webhook_url is set
      if (config.webhook_url) {
        const existing = await stripe.webhookEndpoints.list({ limit: 100 })
        const managed = existing.data.find(
          (wh) => wh.url === config.webhook_url && wh.metadata?.managed_by === 'stripe-sync'
        )
        if (managed && managed.status === 'enabled') {
          // Endpoint already exists — ensure we have the secret to verify webhooks
          if (!config.webhook_secret) {
            throw new Error(
              'Existing managed webhook endpoint found for this URL but webhook_secret ' +
                'is not configured. The secret is only available at endpoint creation time — ' +
                'provide it in the pipeline config.'
            )
          }
          // Endpoint exists and we have the secret — nothing to do
        } else {
          // Tradeoff: we subscribe to all events ('*') rather than only the
          // events needed by this sync's catalog. This is not ideal — Stripe
          // will send events we don't need, adding unnecessary network traffic.
          // However, Stripe accounts have a hard limit on webhook endpoints
          // (~16 per account), and scoping events per-sync would require one
          // endpoint per sync. By sharing a single endpoint across all syncs
          // for the same account, each sync filters events by its own catalog
          // inside processStripeEvent(), keeping endpoint usage constant
          // regardless of how many syncs are configured.
          const created = await stripe.webhookEndpoints.create({
            url: config.webhook_url,
            enabled_events: ['*'],
            metadata: { managed_by: 'stripe-sync' },
          })
          // Secret is only available at creation time — not on list/retrieve
          if (!config.webhook_secret && created.secret) {
            updates.webhook_secret = created.secret
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        yield {
          type: 'control' as const,
          control: {
            control_type: 'config_update' as const,
            config: updates as Record<string, unknown>,
          },
        }
      }
    },

    async *teardown({ config }): AsyncGenerator<TeardownOutput> {
      if (config.webhook_url) {
        const stripe = makeClient(config)
        const existing = await stripe.webhookEndpoints.list({ limit: 100 })
        // Only delete the endpoint matching THIS pipeline's URL — not all managed endpoints.
        // Other pipelines on the same account may share the managed_by tag with different URLs.
        const target = existing.data.find(
          (wh) => wh.url === config.webhook_url && wh.metadata?.managed_by === 'stripe-sync'
        )
        if (target) {
          await stripe.webhookEndpoints.del(target.id)
        }
      }
    },

    async *read({ config, catalog, state }, $stdin?) {
      const rateLimiter =
        externalRateLimiter ?? createInMemoryRateLimiter(config.rate_limit ?? DEFAULT_MAX_RPS)
      const stripe = makeClient(config)
      const resolved = await resolveOpenApiSpec(
        { apiVersion: config.api_version ?? BUNDLED_API_VERSION },
        apiFetch
      )
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
