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
  globalState?: { events_cursor?: number }
  startTimestamp: number
  accountId: string
}): AsyncGenerator<Message> {
  const { config, client, catalog, registry, streamNames, state, startTimestamp, accountId } = opts

  if (!config.poll_events) return

  // Only poll when all streams have empty remaining arrays (backfill finished)
  const allComplete = catalog.streams.every((cs) => {
    const streamState = state?.[cs.stream.name]
    if (!streamState) return false
    if (!('remaining' in streamState)) return false
    return streamState.remaining.length === 0
  })
  if (!allComplete) return

  const cursor = opts.globalState?.events_cursor

  // First run after backfill: stamp initial events_cursor in global state
  if (cursor == null) {
    yield stateMsg({
      state_type: 'global' as const,
      data: { events_cursor: startTimestamp },
    })
    return
  }

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

  let latestEventCreated = cursor
  for (const event of events) {
    yield* processStripeEvent(event, config, catalog, registry, streamNames, accountId)
    if (event.created > latestEventCreated) {
      latestEventCreated = event.created
    }
  }

  // Update global events cursor
  if (latestEventCreated > cursor) {
    yield stateMsg({
      state_type: 'global' as const,
      data: { events_cursor: latestEventCreated },
    })
  }
}
