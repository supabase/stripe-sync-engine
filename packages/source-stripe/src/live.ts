import type Stripe from 'stripe'
import type { Message } from '@stripe/sync-protocol'
import { fromWebhookEvent } from './backfill'
import type { ResourceConfig } from './types'

/**
 * Async generator that converts a stream of Stripe webhook events into
 * protocol messages (RecordMessage + StateMessage pairs).
 *
 * This is the "live mode" counterpart to source.read() (backfill mode).
 * The orchestrator feeds webhook events in; this generator yields protocol
 * messages out.
 */
export async function* liveReader(
  events: AsyncIterableIterator<Stripe.Event>,
  registry: Record<string, ResourceConfig>
): AsyncIterableIterator<Message> {
  for await (const event of events) {
    const result = fromWebhookEvent(event, registry)
    if (result) {
      yield result.record
      yield result.state
    }
  }
}
