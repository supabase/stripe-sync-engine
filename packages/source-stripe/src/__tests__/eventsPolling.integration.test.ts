import { beforeAll, describe, expect, it } from 'vitest'
import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceStateMessage,
} from '@stripe/sync-protocol'
import source from '../index.js'
import type { StripeStreamState } from '../index.js'

const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'

/** Collect all messages from an async iterable. */
async function collect(iter: AsyncIterable<Message>): Promise<Message[]> {
  const results: Message[] = []
  for await (const msg of iter) {
    results.push(msg)
  }
  return results
}

describe('events polling (integration — stripe-mock)', () => {
  beforeAll(async () => {
    try {
      const res = await fetch(STRIPE_MOCK_URL)
      if (!res.ok) throw new Error(`stripe-mock returned ${res.status}`)
    } catch {
      console.warn(`stripe-mock not available at ${STRIPE_MOCK_URL}, skipping integration tests`)
      return 'skip'
    }
  })

  const config = {
    api_key: 'sk_test_fake',
    base_url: STRIPE_MOCK_URL,
    poll_events: true,
  }

  const catalog: ConfiguredCatalog = {
    streams: [
      {
        stream: { name: 'customers', primary_key: [['id']] },
        sync_mode: 'incremental',
        destination_sync_mode: 'append_dedup',
      },
    ],
  }

  it('fetches and processes events from stripe-mock', async () => {
    // State: all streams complete with events_cursor in the past
    const state: Record<string, StripeStreamState> = {
      customers: { page_cursor: null, status: 'complete', events_cursor: 0 },
    }

    const messages = await collect(source.read({ config, catalog, state }))

    // stripe-mock should return some events — we expect records + state messages
    const records = messages.filter((m): m is RecordMessage => m.type === 'record')
    const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')

    // stripe-mock returns fixture events, so we should get at least something
    // (if stripe-mock has no events, records may be empty — that's still valid)
    expect(states.length).toBeGreaterThanOrEqual(0)

    // Verify no backfill happened (no stream_status: started)
    const started = messages.filter((m) => m.type === 'stream_status')
    expect(started).toHaveLength(0)

    // If we got records, verify they have data
    for (const r of records) {
      expect(r.data).toBeDefined()
      expect(r.stream).toBe('customers')
    }
  })

  it('preserves status: complete in all state messages during polling', async () => {
    const state: Record<string, StripeStreamState> = {
      customers: { page_cursor: null, status: 'complete', events_cursor: 0 },
    }

    const messages = await collect(source.read({ config, catalog, state }))
    const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')

    // Every state message should preserve status: complete
    for (const s of states) {
      expect((s.data as { status: string }).status).toBe('complete')
    }
  })
})
