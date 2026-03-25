import type { ConfiguredCatalog, LogMessage, Message, StateMessage } from '@stripe/protocol'
import type Stripe from 'stripe'
import type { Config, StripeStreamState } from './index.js'
import type { ResourceConfig } from './types.js'
import { processStripeEvent } from './process-event.js'

// MARK: - Events polling

const EVENTS_MAX_AGE_DAYS = 25

export async function* pollEvents(opts: {
  config: Config
  stripe: Stripe
  catalog: ConfiguredCatalog
  registry: Record<string, ResourceConfig>
  streamNames: Set<string>
  state: Record<string, StripeStreamState> | undefined
  startTimestamp: number
}): AsyncGenerator<Message> {
  const { config, stripe, catalog, registry, streamNames, state, startTimestamp } = opts

  if (!config.poll_events) return

  // Only poll when all streams are complete (backfill finished)
  const allComplete = catalog.streams.every((cs) => state?.[cs.stream.name]?.status === 'complete')
  if (!allComplete) return

  // Collect events_cursor values from all streams
  const cursors: number[] = []
  for (const cs of catalog.streams) {
    const cursor = state?.[cs.stream.name]?.events_cursor
    if (cursor != null) cursors.push(cursor)
  }

  // First run after backfill: stamp initial events_cursor on all streams
  if (cursors.length === 0) {
    for (const cs of catalog.streams) {
      const existing = state?.[cs.stream.name]
      yield {
        type: 'state',
        stream: cs.stream.name,
        data: {
          pageCursor: existing?.pageCursor ?? null,
          status: 'complete' as const,
          events_cursor: startTimestamp,
        },
      } satisfies StateMessage
    }
    return
  }

  const cursor = Math.min(...cursors)

  // Warn if cursor is too old (Stripe retains events for ~30 days)
  const ageInDays = (startTimestamp - cursor) / 86400
  if (ageInDays > EVENTS_MAX_AGE_DAYS) {
    yield {
      type: 'log',
      level: 'warn',
      message: `Events cursor is ${Math.round(ageInDays)} days old. Stripe retains events for ~30 days. Consider a full re-sync.`,
    } satisfies LogMessage
  }

  // Fetch events since cursor (API returns newest-first)
  const events: Stripe.Event[] = []
  for await (const event of stripe.events.list({ created: { gt: cursor } })) {
    events.push(event)
  }

  // Process oldest-first
  events.reverse()

  for (const event of events) {
    for await (const msg of processStripeEvent(
      event,
      config,
      stripe,
      catalog,
      registry,
      streamNames
    )) {
      if (msg.type === 'state') {
        // Intercept state messages to preserve complete status + update events_cursor
        const existing = state?.[msg.stream]
        yield {
          type: 'state',
          stream: msg.stream,
          data: {
            pageCursor: existing?.pageCursor ?? null,
            status: 'complete' as const,
            events_cursor: event.created,
          },
        } satisfies StateMessage
      } else {
        yield msg
      }
    }
  }
}
