import type { ConfiguredCatalog, LogMessage, Message } from '@stripe/sync-protocol'
import { stateMsg } from '@stripe/sync-protocol'
import type { StripeEvent } from './spec.js'
import type { Config, StripeStreamState } from './index.js'
import type { ResourceConfig } from './types.js'
import type { StripeClient } from './client.js'
import { processStripeEvent } from './process-event.js'

// MARK: - Events polling

const EVENTS_MAX_AGE_DAYS = 25

export async function* pollEvents(opts: {
  config: Config
  client: StripeClient
  catalog: ConfiguredCatalog
  registry: Record<string, ResourceConfig>
  streamNames: Set<string>
  state: Record<string, StripeStreamState> | undefined
  startTimestamp: number
  accountId: string
}): AsyncGenerator<Message> {
  const { config, client, catalog, registry, streamNames, state, startTimestamp, accountId } = opts

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
      yield stateMsg({
        stream: cs.stream.name,
        data: {
          page_cursor: existing?.page_cursor ?? null,
          status: 'complete' as const,
          events_cursor: startTimestamp,
        },
      })
    }
    return
  }

  const cursor = Math.min(...cursors)

  // Warn if cursor is too old (Stripe retains events for ~30 days)
  const ageInDays = (startTimestamp - cursor) / 86400
  if (ageInDays > EVENTS_MAX_AGE_DAYS) {
    yield {
      type: 'log',
      log: {
        level: 'warn',
        message: `Events cursor is ${Math.round(ageInDays)} days old. Stripe retains events for ~30 days. Consider a full re-sync.`,
      },
    } satisfies LogMessage
  }

  // Fetch all events since cursor via pagination (API returns newest-first)
  const events: StripeEvent[] = []
  let startingAfter: string | undefined
  let hasMore = true

  while (hasMore) {
    const page = await client.listEvents({
      created: { gt: cursor },
      limit: 100,
      starting_after: startingAfter,
    })
    events.push(...page.data)
    hasMore = page.has_more
    if (page.data.length > 0) {
      startingAfter = page.data[page.data.length - 1]!.id
    }
  }

  // Process oldest-first
  events.reverse()

  for (const event of events) {
    for await (const msg of processStripeEvent(
      event,
      config,
      catalog,
      registry,
      streamNames,
      accountId
    )) {
      if (msg.type === 'source_state' && msg.source_state.state_type !== 'global') {
        // Intercept state messages to preserve complete status + update events_cursor
        const existing = state?.[msg.source_state.stream]
        yield stateMsg({
          stream: msg.source_state.stream,
          data: {
            page_cursor: existing?.page_cursor ?? null,
            status: 'complete' as const,
            events_cursor: event.created,
          },
        })
      } else {
        yield msg
      }
    }
  }
}
