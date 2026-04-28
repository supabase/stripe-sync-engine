import { describe, expect, it } from 'vitest'
import type { ProgressPayload } from '@stripe/sync-protocol'
import { formatProgress } from './format.js'

describe('formatProgress', () => {
  it('formats a fresh sync with no records yet', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 0,
      global_state_count: 0,
      derived: { status: 'started', records_per_second: 0, states_per_second: 0, total_record_count: 0, total_state_count: 0 },
      streams: {
        customers: { status: 'not_started', state_count: 0, record_count: 0 },
        invoices: { status: 'not_started', state_count: 0, record_count: 0 },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "Syncing 2 streams (2 not_started) — 0.0s — started Jan 1, 12:00 AM UTC
             0 records               0.0/s
       ○ customers, invoices"
    `)
  })

  it('formats active sync with many streams', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 12400,
      global_state_count: 18,
      derived: { status: 'started', records_per_second: 245.2, states_per_second: 1.5, total_record_count: 3451, total_state_count: 16 },
      streams: {
        accounts: { status: 'completed', state_count: 1, record_count: 1 },
        customers: { status: 'completed', state_count: 4, record_count: 1200 },
        invoices: { status: 'completed', state_count: 3, record_count: 850 },
        charges: { status: 'started', state_count: 5, record_count: 980 },
        payment_intents: { status: 'started', state_count: 3, record_count: 420 },
        subscriptions: { status: 'not_started', state_count: 0, record_count: 0 },
        products: { status: 'not_started', state_count: 0, record_count: 0 },
        prices: { status: 'not_started', state_count: 0, record_count: 0 },
        balance_transactions: { status: 'not_started', state_count: 0, record_count: 0 },
        payouts: { status: 'not_started', state_count: 0, record_count: 0 },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "Syncing 10 streams (3 completed, 2 started, 5 not_started) — 12.4s — started Jan 1, 12:00 AM UTC
          3451 records             245.2/s       18 checkpoints               1.5/s
       ● charges                                 980 records
       ● payment_intents                         420 records
       ● accounts                                  1 records
       ● customers                              1200 records
       ● invoices                                850 records
       ○ subscriptions, products, prices, balance_transactions, payouts"
    `)
  })

  it('formats failed sync with connection error', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 1500,
      global_state_count: 0,
      derived: { status: 'failed', records_per_second: 0, states_per_second: 0, total_record_count: 0, total_state_count: 0 },
      streams: {
        customers: { status: 'errored', state_count: 0, record_count: 0 },
      },
      connection_status: { status: 'failed', message: 'Invalid API key' },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "Sync failed 1 streams (1 errored) — 1.5s — started Jan 1, 12:00 AM UTC
             0 records               0.0/s
       ● customers

      Invalid API key"
    `)
  })

  it('formats sync with skipped streams', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 5000,
      global_state_count: 2,
      derived: { status: 'started', records_per_second: 50, states_per_second: 0.4, total_record_count: 100, total_state_count: 2 },
      streams: {
        customers: { status: 'completed', state_count: 2, record_count: 100 },
        invoices: {
          status: 'skipped',
          state_count: 0,
          record_count: 0,
          message: 'Only available in testmode',
        },
      },
    }

    expect(formatProgress(progress)).toMatchInlineSnapshot(`
      "Syncing 2 streams (1 completed, 1 skipped) — 5.0s — started Jan 1, 12:00 AM UTC
           100 records              50.0/s        2 checkpoints               0.4/s
       ● customers                               100 records
       ⏭ invoices
          Only available in testmode"
    `)
  })

  it('range bar only fills columns that are 100% covered', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 5000,
      global_state_count: 3,
      derived: { status: 'started', records_per_second: 100, states_per_second: 0.6, total_record_count: 500, total_state_count: 3 },
      streams: {
        customers: {
          status: 'started',
          state_count: 3,
          record_count: 500,
          total_range: { gte: '2020-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
          completed_ranges: [
            // First 2 years complete (40% of 5-year span)
            { gte: '2020-01-01T00:00:00Z', lt: '2022-01-01T00:00:00Z' },
            // Last year complete (20% of 5-year span)
            { gte: '2024-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
          ],
        },
      },
    }

    const output = formatProgress(progress)
    // Extract the bar portion between [ and ]
    const barMatch = output.match(/\[.*?([\u2588\u2591]+).*?\]/)
    expect(barMatch).not.toBeNull()
    const bar = barMatch![1]
    expect(bar).toHaveLength(40)

    // First 40% (16 chars) should be filled
    const filledPrefix = bar.slice(0, 16)
    expect(filledPrefix).toMatch(/^\u2588+$/)

    // Middle section (40%-80%, 16 chars) should be empty
    const emptyMiddle = bar.slice(16, 32)
    expect(emptyMiddle).toMatch(/^\u2591+$/)

    // Last 20% (8 chars) should be filled
    const filledSuffix = bar.slice(32, 40)
    expect(filledSuffix).toMatch(/^\u2588+$/)
  })

  it('range bar column stays empty when only partially covered', () => {
    const progress: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 1000,
      global_state_count: 1,
      derived: { status: 'started', records_per_second: 50, states_per_second: 1, total_record_count: 50, total_state_count: 1 },
      streams: {
        customers: {
          status: 'started',
          state_count: 1,
          record_count: 50,
          total_range: { gte: '2020-01-01T00:00:00Z', lt: '2025-01-01T00:00:00Z' },
          completed_ranges: [
            // A tiny 1-second range in the middle — should NOT light up its column
            { gte: '2022-06-15T12:00:00Z', lt: '2022-06-15T12:00:01Z' },
          ],
        },
      },
    }

    const output = formatProgress(progress)
    const barMatch = output.match(/\[.*?([\u2588\u2591]+).*?\]/)
    expect(barMatch).not.toBeNull()
    const bar = barMatch![1]
    // A 1-second range in a ~1-month column should NOT fill it
    expect(bar).toMatch(/^\u2591+$/)
  })

  it('shows deltas when previous progress is provided', () => {
    const prev: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 2000,
      global_state_count: 2,
      derived: { status: 'started', records_per_second: 100, states_per_second: 1, total_record_count: 200, total_state_count: 2 },
      streams: {
        customers: { status: 'started', state_count: 1, record_count: 150 },
        invoices: { status: 'started', state_count: 1, record_count: 50 },
        charges: { status: 'not_started', state_count: 0, record_count: 0 },
      },
    }

    const current: ProgressPayload = {
      started_at: '2026-01-01T00:00:00Z',
      elapsed_ms: 4000,
      global_state_count: 5,
      derived: { status: 'started', records_per_second: 112.5, states_per_second: 1.25, total_record_count: 450, total_state_count: 5 },
      streams: {
        customers: { status: 'completed', state_count: 2, record_count: 200 },
        invoices: { status: 'started', state_count: 2, record_count: 180 },
        charges: { status: 'started', state_count: 1, record_count: 70 },
      },
    }

    expect(formatProgress(current, prev)).toMatchInlineSnapshot(`
      "Syncing 3 streams (1 completed, 2 started) — 4.0s — started Jan 1, 12:00 AM UTC
           450 records   (+250)    112.5/s        5 checkpoints     (+3)      1.3/s
       ● invoices                                180 records   (+130)
       ● charges                                  70 records    (+70)
       ● customers                               200 records    (+50)"
    `)
  })
})
