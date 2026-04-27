import type {
  CatalogPayload,
  Source,
  SpecOutput,
  CheckOutput,
  DiscoverOutput,
  SetupOutput,
  TeardownOutput,
} from '@stripe/sync-protocol'
import { createSourceMessageFactory, withAbortOnReturn } from '@stripe/sync-protocol'
import defaultSpec from './spec.js'
import type { Config } from './spec.js'
import type { StripeEvent } from './spec.js'
import { buildResourceRegistry } from './resourceRegistry.js'
import { catalogFromOpenApi, stampAccountIdEnum } from './catalog.js'
import {
  BUNDLED_API_VERSION,
  resolveOpenApiSpec,
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from '@stripe/sync-openapi'
import { processStripeEvent } from './process-event.js'
import { processWebhookInput, createInputQueue, startWebhookServer } from './src-webhook.js'
import { listApiBackfill, errorToConnectionStatus } from './src-list-api.js'
import { pollEvents } from './src-events-api.js'
import type { StripeWebSocketClient, StripeWebhookEvent } from './src-websocket.js'
import { createStripeWebSocketClient } from './src-websocket.js'
import { makeClient, type StripeClient } from './client.js'
import type { RateLimiter } from './rate-limiter.js'
import { createInMemoryRateLimiter } from './rate-limiter.js'
import { tracedFetch } from './transport.js'
import { stripeEventSchema } from './spec.js'
import { resolveAccountMetadata } from './account-metadata.js'
import { log } from './logger.js'

function combineSignals(
  ...signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal != null)
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]
  return AbortSignal.any(activeSignals)
}

function makeApiFetch(signal?: AbortSignal): typeof globalThis.fetch {
  return (input, init) =>
    tracedFetch(input as URL | string, {
      ...(init ?? {}),
      signal: combineSignals(init?.signal, signal),
    })
}

/** In-memory cache of discover results. */
export const discoverCache = new Map<string, CatalogPayload>()

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj
  for (const key of Reflect.ownKeys(obj)) {
    deepFreeze((obj as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(obj)
}

function resolveAllowedAccountIds(accountId: string, _config: Config): string[] {
  return [accountId]
}

// MARK: - Spec

export { configSchema, type Config } from './spec.js'

/** Raw webhook payload requiring signature verification. */
export type WebhookInput = {
  body: string | Buffer
  headers: Record<string, string | string[] | undefined>
}

// MARK: - Stream state

export type RemainingRange = {
  gte: string // ISO 8601
  lt: string // ISO 8601
  cursor: string | null // Stripe pagination cursor; null = not yet started
}

export type StreamState = {
  accounted_range?: {
    gte: string // ISO 8601 — inclusive lower bound
    lt: string // ISO 8601 — exclusive upper bound
  }
  remaining: RemainingRange[]
}

export type EventState = { eventId: string; eventCreated: number }

export type GlobalState = { events_cursor: number }

/** Single message factory for the entire Stripe source. All files import this. */
export const msg = createSourceMessageFactory<
  StreamState | EventState,
  GlobalState,
  Record<string, unknown>
>()

// MARK: - Account ID resolution

export async function resolveAccountId(config: Config, client: StripeClient): Promise<string> {
  return (await resolveAccountMetadata(config, client)).accountId
}

// MARK: - Source

export type StripeSourceDeps = {
  rateLimiter?: RateLimiter
}

export function createStripeSource(
  deps?: StripeSourceDeps
): Source<Config, StreamState, WebhookInput | StripeEvent> {
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
        yield msg.connection_status({ status: 'succeeded' })
      } catch (err: unknown) {
        yield msg.connection_status({
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    // Discover stamps the catalog with the per-pipeline `_account_id`
    // allow-list so destinations can derive write-time tenancy constraints.
    // We trust `config.account_id` when set (populated by `setup()`); only
    // fall back to a live `GET /v1/account` when it's missing, otherwise
    // pipeline_sync would pay an HTTP roundtrip on every read+write cycle.
    async *discover({ config }): AsyncGenerator<DiscoverOutput> {
      const apiVersion = config.api_version ?? BUNDLED_API_VERSION
      let accountId = config.account_id
      if (!accountId) {
        const client = makeClient({ ...config, api_version: apiVersion })
        accountId = (await client.getAccount({ maxRetries: 0 })).id
      }
      const allowedAccountIds = resolveAllowedAccountIds(accountId, config)

      const cached = discoverCache.get(apiVersion)
      if (cached) {
        yield {
          type: 'catalog' as const,
          catalog: stampAccountIdEnum(cached, allowedAccountIds),
        }
        return
      }

      const resolved = await resolveOpenApiSpec({ apiVersion }, makeApiFetch())
      const registry = buildResourceRegistry(
        resolved.spec,
        config.api_key,
        resolved.apiVersion,
        config.base_url
      )
      const parser = new SpecParser()
      const parsed = parser.parse(resolved.spec, {
        resourceAliases: OPENAPI_RESOURCE_TABLE_ALIASES,
      })
      const catalog = catalogFromOpenApi(parsed.tables, registry)
      const frozenCatalog = deepFreeze(catalog)
      discoverCache.set(apiVersion, frozenCatalog)
      yield {
        type: 'catalog' as const,
        catalog: stampAccountIdEnum(frozenCatalog, allowedAccountIds),
      }
    },

    async *setup({ config, catalog: _catalog }): AsyncGenerator<SetupOutput> {
      const updates: Partial<Config> = {}
      const client = makeClient({
        ...config,
        api_version: config.api_version ?? BUNDLED_API_VERSION,
      })

      if (!config.account_id || config.account_created == null) {
        log.debug('source setup: resolving account metadata')
        try {
          const resolved = await resolveAccountMetadata(config, client)
          if (!config.account_id) updates.account_id = resolved.accountId
          if (config.account_created == null) updates.account_created = resolved.accountCreated
        } catch (err) {
          // Non-fatal: fall back to defaults. account_id may be derived from the API key later,
          // and account_created defaults to Stripe's launch date (2011-01-01).
          log.warn(
            {
              err,
            },
            'Failed to resolve account metadata during setup'
          )
        }
        log.debug('source setup: account metadata resolved')
      }

      // Create managed webhook endpoint if webhook_url is set
      if (config.webhook_url) {
        log.debug('source setup: listing webhook endpoints')
        const existing = await client.listWebhookEndpoints({ limit: 100 })
        const managed = existing.data.find(
          (wh) => wh.url === config.webhook_url && wh.metadata?.managed_by === 'stripe-sync'
        )
        if (managed && managed.status === 'enabled') {
          // Endpoint already exists — warn if we don't have the secret to verify webhooks
          if (!config.webhook_secret) {
            log.error(
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
        log.debug('source setup: webhook endpoints handled')
      }

      log.debug({ hasUpdates: Object.keys(updates).length > 0 }, 'source setup: complete')
      if (Object.keys(updates).length > 0) {
        yield msg.control({
          control_type: 'source_config',
          source_config: { ...config, ...updates },
        })
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

    read({ config, catalog, state }, $stdin?) {
      return withAbortOnReturn((signal) =>
        (async function* () {
          const apiVersion = config.api_version ?? BUNDLED_API_VERSION

          // Derive concurrency params from API key mode (overridable via config)
          const liveMode =
            config.api_key.startsWith('sk_live_') || config.api_key.startsWith('rk_live_')
          const maxRequestsPerSecond = config.rate_limit ?? (liveMode ? 50 : 10) // 50% of rate limits by default
          const maxConcurrentStreams = Math.min(maxRequestsPerSecond, catalog.streams.length)

          const rateLimiter = externalRateLimiter ?? createInMemoryRateLimiter(maxRequestsPerSecond)
          const client = makeClient({ ...config, api_version: apiVersion }, undefined, signal)
          const resolved = await resolveOpenApiSpec({ apiVersion }, makeApiFetch(signal))
          const streamNames = new Set(catalog.streams.map((s) => s.stream.name))
          const registry = buildResourceRegistry(
            resolved.spec,
            config.api_key,
            resolved.apiVersion,
            config.base_url,
            streamNames,
            signal
          )
          let accountId: string
          let accountCreated: number
          try {
            const resolvedAccount = await resolveAccountMetadata(config, client)
            accountId = resolvedAccount.accountId
            accountCreated = resolvedAccount.accountCreated
          } catch (err) {
            yield errorToConnectionStatus(err)
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
                const event = stripeEventSchema.parse(input)
                yield* processStripeEvent(event, config, catalog, registry, streamNames, accountId)
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
              state: state?.streams as Record<string, unknown> | undefined,
              registry,
              rateLimiter,
              client,
              accountCreated,
              accountId,
              backfillLimit: config.backfill_limit,
              maxConcurrentStreams,
              signal,
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
              state: state?.streams as Record<string, StreamState> | undefined,
              globalState: state?.global as { events_cursor?: number } | undefined,
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
                const queued = await inputQueue.wait(signal)
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
        })()
      )
    },
  }
}

export default createStripeSource()

// MARK: - Re-exports

export { subdivideRanges } from '@stripe/sync-protocol'
export { buildResourceRegistry, DEFAULT_SYNC_OBJECTS, EXCLUDED_TABLES } from './resourceRegistry.js'
export { catalogFromOpenApi } from './catalog.js'
export { SpecParser, OPENAPI_RESOURCE_TABLE_ALIASES } from '@stripe/sync-openapi'
export type { ParsedResourceTable, ParsedOpenApiSpec } from '@stripe/sync-openapi'
export type { RateLimiter } from './rate-limiter.js'
export { createInMemoryRateLimiter } from './rate-limiter.js'
export { verifyWebhookSignature, WebhookSignatureError } from './webhookVerify.js'
