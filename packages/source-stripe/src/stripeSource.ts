import type {
  CatalogMessage,
  CheckResult,
  ConnectorSpecification,
  ErrorMessage,
  Message,
  RecordMessage,
  Source,
  StateMessage,
  Stream,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'
import type Stripe from 'stripe'
import type { ResourceConfig } from './types'
import { catalogFromRegistry } from './catalog'

/**
 * Stripe source implementation.
 *
 * Reads data from Stripe's core REST API. Supports two modes:
 * - Backfill: paginate List APIs, emit RecordMessage per object
 * - Live: receive webhook events, emit RecordMessage per event
 */
export class StripeSource implements Source {
  constructor(private readonly registry: Record<string, ResourceConfig>) {}

  spec(): ConnectorSpecification {
    return {
      connection_specification: {
        type: 'object',
        required: ['stripe_secret_key'],
        properties: {
          stripe_secret_key: { type: 'string' },
          stripe_account_id: { type: 'string' },
        },
      },
    }
  }

  async check(_config: Record<string, unknown>): Promise<CheckResult> {
    return { status: 'succeeded' }
  }

  async discover(_config: Record<string, unknown>): Promise<CatalogMessage> {
    return catalogFromRegistry(this.registry)
  }

  async *read(
    _config: Record<string, unknown>,
    streams: Stream[],
    state?: StateMessage[]
  ): AsyncIterableIterator<Message> {
    for (const stream of streams) {
      const config = this.findConfigByTableName(stream.name)
      if (!config) {
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

          const response = await config.listFn(params)

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
  }

  /**
   * Convert a single Stripe webhook event into protocol messages.
   *
   * Returns { record, state } for supported events, or null if the event's
   * object type is not in the registry or the object has no id.
   *
   * This is the building block for live mode. The orchestrator/webhook server
   * pushes events in; this method converts them to protocol messages.
   */
  static fromWebhookEvent(
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

  private findConfigByTableName(tableName: string): ResourceConfig | undefined {
    return Object.values(this.registry).find((cfg) => cfg.tableName === tableName)
  }
}
