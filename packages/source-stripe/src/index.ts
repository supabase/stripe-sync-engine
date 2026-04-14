import type {
  CatalogPayload,
  Source,
  SpecOutput,
  CheckOutput,
  DiscoverOutput,
  SetupOutput,
  TeardownOutput,
} from '@stripe/sync-protocol'
import { sourceControlMsg } from '@stripe/sync-protocol'
import { z } from 'zod'
import defaultSpec, { configSchema } from './spec.js'
import type { Config } from './spec.js'
import type { StripeEvent } from './spec.js'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromRegistry, catalogFromOpenApi } from './catalog.js'
import {
  BUNDLED_API_VERSION,
  resolveOpenApiSpec,
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from '@stripe/sync-openapi'
import { processStripeEvent } from './process-event.js'
import { processWebhookInput, createInputQueue, startWebhookServer } from './src-webhook.js'
import { listApiBackfill, errorToTrace } from './src-list-api.js'
import { pollEvents } from './src-events-api.js'
import type { StripeWebSocketClient, StripeWebhookEvent } from './src-websocket.js'
import { createStripeWebSocketClient } from './src-websocket.js'
import type { ResourceConfig } from './types.js'
import { makeClient, type StripeClient } from './client.js'
import type { RateLimiter } from './rate-limiter.js'
import { createInMemoryRateLimiter, DEFAULT_MAX_RPS } from './rate-limiter.js'
import { fetchWithProxy } from './transport.js'
import { stripeEventSchema } from './spec.js'

const apiFetch: typeof globalThis.fetch = (input, init) =>
  fetchWithProxy(input as URL | string, init ?? {})

/** In-memory cache of discover results keyed by api_version. */
export const discoverCache = new Map<string, CatalogPayload>()

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
  page_cursor: string | null
  status: 'pending' | 'complete'
}

/** Compact backfill state — O(concurrency) not O(total segments). */
export type BackfillState = {
  range: { gte: number; lt: number }
  num_segments: number
  completed: Array<{ gte: number; lt: number }>
  in_flight: Array<{ gte: number; lt: number; page_cursor: string }>
}

export type StripeStreamState = {
  page_cursor: string | null
  status: 'pending' | 'complete'
  events_cursor?: number
  /** @deprecated Legacy — use backfill instead */
  segments?: SegmentState[]
  backfill?: BackfillState
}

// MARK: - Account ID resolution

export async function resolveAccountId(config: Config, client: StripeClient): Promise<string> {
  if (config.account_id) {
    return config.account_id
  }

  const account = await client.getAccount()
  return account.id
}

// MARK: - Source

export type StripeSourceDeps = {
  rateLimiter?: RateLimiter
}

export function createStripeSource(
  deps?: StripeSourceDeps
): Source<Config, StripeStreamState, WebhookInput | StripeEvent> {
  const externalRateLimiter = deps?.rateLimiter

  return {
    async *spec(): AsyncGenerator<SpecOutput> {
      yield { type: 'spec' as const, spec: defaultSpec }
    },

    async *check({ config }): AsyncGenerator<CheckOutput> {
      try {
        const client = makeClient({
          ...config,
          api_version: config.api_version ?? BUNDLED_API_VERSION,
        })
        await client.getAccount()
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

    // For the default api_version (bundled), discover is CPU-only — no HTTP.
    // resolveOpenApiSpec serves the bundled spec from the filesystem, so the
    // cost is SpecParser.parse + catalogFromOpenApi (pure computation). We
    // cache the result in-memory keyed by api_version so that pipeline_sync
    // (which calls discover twice — once in pipeline_read, once in
    // pipeline_write) doesn't repeat the work.
    // TODO: Custom objects (not yet supported) would require a more specific cache
    // since they aren't discoverable from the OpenAPI spec alone.
    async *discover({ config }): AsyncGenerator<DiscoverOutput> {
      const apiVersion = config.api_version ?? BUNDLED_API_VERSION
      const cached = discoverCache.get(apiVersion)
      if (cached) {
        yield { type: 'catalog' as const, catalog: cached }
        return
      }

      const resolved = await resolveOpenApiSpec({ apiVersion }, apiFetch)
      const registry = buildResourceRegistry(
        resolved.spec,
        config.api_key,
        resolved.apiVersion,
        config.base_url
      )
      let catalog: CatalogPayload
      try {
        const parser = new SpecParser()
        const parsed = parser.parse(resolved.spec, {
          resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
        })
        catalog = catalogFromOpenApi(parsed.tables, registry)
      } catch {
        catalog = catalogFromRegistry(registry)
      }
      discoverCache.set(apiVersion, catalog)
      yield { type: 'catalog' as const, catalog }
    },

    async *setup({ config, catalog }): AsyncGenerator<SetupOutput> {
      const updates: Partial<Config> = {}
      const client = makeClient({
        ...config,
        api_version: config.api_version ?? BUNDLED_API_VERSION,
      })

      // Resolve account_id if not already set
      if (!config.account_id) {
        const account = await client.getAccount()
        updates.account_id = account.id
      }

      // Create managed webhook endpoint if webhook_url is set
      if (config.webhook_url) {
        const existing = await client.listWebhookEndpoints({ limit: 100 })
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
          const created = await client.createWebhookEndpoint({
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
        yield sourceControlMsg({ ...config, ...updates })
      }
    },

    async *teardown({ config }): AsyncGenerator<TeardownOutput> {
      if (config.webhook_url) {
        const client = makeClient({
          ...config,
          api_version: config.api_version ?? BUNDLED_API_VERSION,
        })
        const existing = await client.listWebhookEndpoints({ limit: 100 })
        // Only delete the endpoint matching THIS pipeline's URL — not all managed endpoints.
        // Other pipelines on the same account may share the managed_by tag with different URLs.
        const target = existing.data.find(
          (wh) => wh.url === config.webhook_url && wh.metadata?.managed_by === 'stripe-sync'
        )
        if (target) {
          await client.deleteWebhookEndpoint(target.id)
        }
      }
    },

    async *read({ config, catalog, state }, $stdin?, signal?) {
      const apiVersion = config.api_version ?? BUNDLED_API_VERSION
      const rateLimiter =
        externalRateLimiter ?? createInMemoryRateLimiter(config.rate_limit ?? DEFAULT_MAX_RPS)
      const client = makeClient({ ...config, api_version: apiVersion }, undefined, signal)
      const resolved = await resolveOpenApiSpec({ apiVersion }, apiFetch)
      const registry = buildResourceRegistry(
        resolved.spec,
        config.api_key,
        resolved.apiVersion,
        config.base_url
      )
      const streamNames = new Set(catalog.streams.map((s) => s.stream.name))
      let accountId: string
      try {
        accountId = await resolveAccountId(config, client)
      } catch (err) {
        yield errorToTrace(err, catalog.streams[0]?.stream.name ?? 'unknown')
        return
      }

      // Event-driven mode: iterate over incoming webhook inputs
      if ($stdin) {
        for await (const input of $stdin) {
          if ('body' in (input as object)) {
            yield* processWebhookInput(
              input as WebhookInput,
              config,
              catalog,
              registry,
              streamNames,
              accountId
            )
          } else {
            yield* processStripeEvent(
              input as StripeEvent,
              config,
              catalog,
              registry,
              streamNames,
              accountId
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
            const event = stripeEventSchema.parse(JSON.parse(wsEvent.event_payload))
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
          state: state?.streams as Parameters<typeof listApiBackfill>[0]['state'],
          registry,
          rateLimiter,
          client,
          accountId,
          backfillLimit: config.backfill_limit,
          backfillConcurrency: config.backfill_concurrency,
          drainQueue: wsClient
            ? () => inputQueue.drain(config, catalog, registry, streamNames, accountId)
            : undefined,
        })

        // Events polling: incremental sync via /v1/events after backfill
        yield* pollEvents({
          config,
          client,
          catalog,
          registry,
          streamNames,
          state: state?.streams as Record<string, StripeStreamState> | undefined,
          startTimestamp,
          accountId,
        })

        // Start HTTP server for live mode if configured
        if (config.webhook_port) {
          httpServer = startWebhookServer(config.webhook_port, inputQueue.push)
        }

        // After backfill: stream live events from WebSocket and/or HTTP
        if (wsClient || httpServer) {
          // Drain anything that arrived during backfill
          yield* inputQueue.drain(config, catalog, registry, streamNames, accountId)

          // Block on new events (infinite loop until all live sources close)
          while (wsClient || httpServer) {
            const queued = await inputQueue.wait()
            try {
              if ('body' in queued.data) {
                yield* processWebhookInput(
                  queued.data,
                  config,
                  catalog,
                  registry,
                  streamNames,
                  accountId
                )
              } else {
                yield* processStripeEvent(
                  queued.data,
                  config,
                  catalog,
                  registry,
                  streamNames,
                  accountId
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

export { expandState } from './src-list-api.js'
export { buildResourceRegistry, DEFAULT_SYNC_OBJECTS } from './resourceRegistry.js'
export { catalogFromRegistry } from './catalog.js'
export { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from './openapi/specParser.js'
export type { ParsedResourceTable, ParsedOpenApiSpec } from './openapi/types.js'
export type { RateLimiter } from './rate-limiter.js'
export { createInMemoryRateLimiter, DEFAULT_MAX_RPS } from './rate-limiter.js'
export { verifyWebhookSignature, WebhookSignatureError } from './webhookVerify.js'
