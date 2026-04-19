import { describe, expect, it } from 'vitest'
import type { ProgressPayload } from '@stripe/sync-protocol'
import { formatProgress } from './format.js'

describe('formatProgress', () => {
  it('formats a fresh sync with no records yet', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 0,
      global_state_count: 0,
      derived: { status: 'started', records_per_second: 0, states_per_second: 0 },
      streams: {
        customers: { status: 'not_started', state_count: 0, record_count: 0 },
        invoices: { status: 'not_started', state_count: 0, record_count: 0 },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "🔄 Syncing — 0.0s
        ⏳ customers
        ⏳ invoices"
    `)
  })

  it('formats active sync with rows and throughput', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 3200,
      global_state_count: 5,
      derived: { status: 'started', records_per_second: 140.6, states_per_second: 1.5 },
      streams: {
        customers: { status: 'completed', state_count: 3, record_count: 200 },
        invoices: { status: 'started', state_count: 2, record_count: 250 },
        charges: { status: 'not_started', state_count: 0, record_count: 0 },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "🔄 Syncing — 3.2s | 450 rows (140.6/s) | 5 checkpoints
        ✅ customers: 200 rows
        🔄 invoices: 250 rows
        ⏳ charges"
    `)
  })

  it('formats failed sync with connection error', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 1500,
      global_state_count: 0,
      derived: { status: 'failed', records_per_second: 0, states_per_second: 0 },
      streams: {
        customers: { status: 'errored', state_count: 0, record_count: 0 },
      },
      connection_status: { status: 'failed', message: 'Invalid API key' },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "❌ Syncing — 1.5s
        ❌ customers
        ⚠️  Invalid API key"
    `)
  })

  it('formats sync with skipped streams', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 5000,
      global_state_count: 2,
      derived: { status: 'started', records_per_second: 50, states_per_second: 0.4 },
      streams: {
        customers: { status: 'completed', state_count: 2, record_count: 100 },
        invoices: { status: 'skipped', state_count: 0, record_count: 0 },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "🔄 Syncing — 5.0s | 100 rows (50.0/s) | 2 checkpoints
        ✅ customers: 100 rows
        ⏭️ invoices"
    `)
  })
})
