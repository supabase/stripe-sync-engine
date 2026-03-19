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
import { buildResourceRegistry } from './resourceRegistry'
import { catalogFromRegistry } from './catalog'

// MARK: - Spec

export const spec = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for stripe-mock)'),
})

export type Config = z.infer<typeof spec>

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
): Source<Config> {
  function getRegistry(config: Config) {
    return _registryForTesting ?? buildResourceRegistry(makeClient(config))
  }

  return {
    spec(): ConnectorSpecification {
      return { connection_specification: z.toJSONSchema(spec) }
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
      return catalogFromRegistry(getRegistry(config))
    },

    async *read({ config, catalog, state }) {
      const registry = getRegistry(config)

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

        // Restore cursor from state array if available
        const streamState = state?.find((s) => s.stream === stream.name)
        let pageCursor: string | null =
          (streamState?.data as { pageCursor?: string | null })?.pageCursor ?? null

        try {
          let hasMore = true
          while (hasMore) {
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
    },
  }
}

const source = createSource()
export default source
