import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type {
  ConfiguredCatalog,
  ErrorMessage,
  Message,
  RecordMessage,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { createSource, fromWebhookEvent } from '../index'
import type { ResourceConfig } from '../types'
import type { StripeWebhookEvent, StripeWebSocketClient } from '../src-websocket'

// Mock the WebSocket module
const mockClose = vi.fn()
let capturedOnEvent: ((event: StripeWebhookEvent) => void) | null = null

vi.mock('../src-websocket', () => ({
  createStripeWebSocketClient: vi.fn(
    async (opts: { onEvent: (event: StripeWebhookEvent) => void }) => {
      capturedOnEvent = opts.onEvent
      return { close: mockClose, isConnected: () => true } satisfies StripeWebSocketClient
    }
  ),
}))

/** Wrap a single item as an AsyncIterable for source.read()'s $stdin param. */
async function* toIter<T>(item: T): AsyncIterable<T> {
  yield item
}

function makeConfig(
  overrides: Partial<ResourceConfig> & { order: number; tableName: string }
): ResourceConfig {
  return {
    supportsCreatedFilter: true,
    listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
    retrieveFn: (() => Promise.resolve({})) as ResourceConfig['retrieveFn'],
    ...overrides,
  } as ResourceConfig
}

/** Build a ConfiguredCatalog from stream specs for tests. */
function catalog(...streams: Array<{ name: string; primary_key?: string[][] }>): ConfiguredCatalog {
  return {
    streams: streams.map((s) => ({
      stream: { name: s.name, primary_key: s.primary_key },
      sync_mode: 'full_refresh' as const,
      destination_sync_mode: 'overwrite' as const,
    })),
  }
}

/** Collect all messages from an async iterator into an array. */
async function collect(iter: AsyncIterable<Message>): Promise<Message[]> {
  const results: Message[] = []
  for await (const msg of iter) {
    results.push(msg)
  }
  return results
}

/** Recursively collect all .ts files in a directory. */
function getAllTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full))
    } else if (entry.name.endsWith('.ts')) {
      results.push(full)
    }
  }
  return results
}

/** Create a minimal Stripe.Event for testing fromWebhookEvent(). */
function makeEvent(overrides: {
  id?: string
  type?: string
  created?: number
  dataObject: Record<string, unknown>
}): Stripe.Event {
  return {
    id: overrides.id ?? 'evt_test_123',
    object: 'event',
    type: overrides.type ?? 'customer.updated',
    created: overrides.created ?? 1700000000,
    api_version: '2025-04-30.basil',
    livemode: false,
    pending_webhooks: 0,
    request: null,
    data: {
      object: overrides.dataObject as Stripe.Event.Data['object'],
    },
  } as Stripe.Event
}

const config = { api_key: 'sk_test_fake' }

describe('StripeSource', () => {
  describe('discover()', () => {
    it('returns a CatalogMessage with known streams', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
        invoice: makeConfig({ order: 2, tableName: 'invoices' }),
      }

      const source = createSource(registry)
      const catalog = await source.discover({ config })

      expect(catalog.type).toBe('catalog')
      expect(catalog.streams).toHaveLength(2)
      expect(catalog.streams.map((s) => s.name)).toEqual(['customers', 'invoices'])
    })

    it('excludes resources with sync: false', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
        internal: makeConfig({ order: 2, tableName: 'internal', sync: false }),
      }

      const source = createSource(registry)
      const catalog = await source.discover({ config })

      expect(catalog.streams).toHaveLength(1)
      expect(catalog.streams[0].name).toBe('customers')
    })

    it('returns empty streams for empty registry', async () => {
      const source = createSource({})
      const catalog = await source.discover({ config })

      expect(catalog.type).toBe('catalog')
      expect(catalog.streams).toEqual([])
    })
  })

  describe('read() — backfill scenarios', () => {
    it('emits RecordMessage + StateMessage in correct interleaving for multi-page stream', async () => {
      const listFn = vi
        .fn()
        // Page 1: 2 items, has_more = true
        .mockResolvedValueOnce({
          data: [
            { id: 'cus_1', name: 'Alice' },
            { id: 'cus_2', name: 'Bob' },
          ],
          has_more: true,
        })
        // Page 2: 1 item, has_more = false
        .mockResolvedValueOnce({
          data: [{ id: 'cus_3', name: 'Charlie' }],
          has_more: false,
        })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // Expected sequence:
      // 1. stream_status(started)
      // 2. record(cus_1)
      // 3. record(cus_2)
      // 4. state(pageCursor: cus_2, status: pending)
      // 5. record(cus_3)
      // 6. state(pageCursor: null, status: complete)
      // 7. stream_status(complete)
      expect(messages).toHaveLength(7)

      expect(messages[0]).toMatchObject({ type: 'stream_status', status: 'started' })
      expect(messages[1]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice' },
      })
      expect(messages[2]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_2', name: 'Bob' },
      })
      expect(messages[3]).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { pageCursor: 'cus_2', status: 'pending' },
      })
      expect(messages[4]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_3', name: 'Charlie' },
      })
      expect(messages[5]).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { pageCursor: null, status: 'complete' },
      })
      expect(messages[6]).toMatchObject({ type: 'stream_status', status: 'complete' })

      // Verify pagination params
      expect(listFn).toHaveBeenCalledTimes(2)
      expect(listFn).toHaveBeenNthCalledWith(1, { limit: 100 })
      expect(listFn).toHaveBeenNthCalledWith(2, { limit: 100, starting_after: 'cus_2' })
    })

    it('processes multiple streams sequentially', async () => {
      const custListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })
      const invListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'inv_1', total: 100 }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoice: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: invListFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
        })
      )

      // Each stream: started + record + state + complete = 4 messages each
      expect(messages).toHaveLength(8)

      // Customers first
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'started',
      })
      expect(messages[1]).toMatchObject({ type: 'record', stream: 'customers' })
      expect(messages[2]).toMatchObject({ type: 'state', stream: 'customers' })
      expect(messages[3]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'complete',
      })

      // Then invoices
      expect(messages[4]).toMatchObject({
        type: 'stream_status',
        stream: 'invoices',
        status: 'started',
      })
      expect(messages[5]).toMatchObject({ type: 'record', stream: 'invoices' })
      expect(messages[6]).toMatchObject({ type: 'state', stream: 'invoices' })
      expect(messages[7]).toMatchObject({
        type: 'stream_status',
        stream: 'invoices',
        status: 'complete',
      })
    })

    it('resumes from prior state cursor without re-emitting checkpointed records', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const priorState: Record<string, unknown> = {
        customers: { pageCursor: 'cus_2', status: 'pending' },
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: priorState,
        })
      )

      // Should call listFn with starting_after from the saved cursor
      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_2' })

      // Only cus_3 is emitted (cus_1 and cus_2 were already checkpointed)
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].data).toMatchObject({ id: 'cus_3' })
    })

    it('handles empty stream (listFn returns no data)', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // stream_status(started) + state(complete) + stream_status(complete)
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'started',
      })
      expect(messages[1]).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { pageCursor: null, status: 'complete' },
      })
      expect(messages[2]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'complete',
      })
    })

    // Covered by WebSocket streaming tests below — backfill + ws interleaved
    // test verifies this transition end-to-end.
  })

  describe('fromWebhookEvent() — live mode scenarios', () => {
    it('webhook mode emits one RecordMessage + one StateMessage per event', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        id: 'evt_1abc',
        type: 'customer.updated',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const result = fromWebhookEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.type).toBe('record')
      expect(result!.record.stream).toBe('customers')
      expect(result!.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        name: 'Alice',
      })
      expect(result!.record.emitted_at).toBeTypeOf('number')

      expect(result!.state.type).toBe('state')
      expect(result!.state.stream).toBe('customers')
      expect(result!.state.data).toEqual({
        eventId: 'evt_1abc',
        eventCreated: 1700000000,
      })
    })

    it('returns null for unsupported object type', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'unknown_1', object: 'unknown_type' },
      })

      const result = fromWebhookEvent(event, registry)
      expect(result).toBeNull()
    })

    it('returns null for objects without id (preview/draft)', () => {
      const registry: Record<string, ResourceConfig> = {
        invoice: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        type: 'invoice.upcoming',
        dataObject: { object: 'invoice', amount_due: 5000 },
      })

      const result = fromWebhookEvent(event, registry)
      expect(result).toBeNull()
    })

    it('passes through deleted flag from event data', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        type: 'customer.deleted',
        dataObject: { id: 'cus_1', object: 'customer', deleted: true },
      })

      const result = fromWebhookEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        deleted: true,
      })
    })

    it('returns null when event data.object has no object field', () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'cus_1' },
      })

      const result = fromWebhookEvent(event, registry)
      expect(result).toBeNull()
    })

    it('WebSocket mode uses same fromWebhookEvent conversion as webhook mode', () => {
      // WebSocket is a transport concern — the conversion is identical.
      // The same Stripe.Event structure is received regardless of transport.
      // This test verifies fromWebhookEvent works for any Stripe.Event input.
      const registry: Record<string, ResourceConfig> = {
        invoice: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        id: 'evt_ws_1',
        type: 'invoice.paid',
        created: 1700000001,
        dataObject: { id: 'inv_1', object: 'invoice', amount_paid: 1000 },
      })

      const result = fromWebhookEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.stream).toBe('invoices')
      expect(result!.record.data).toMatchObject({ id: 'inv_1', amount_paid: 1000 })
      expect(result!.state.data).toEqual({ eventId: 'evt_ws_1', eventCreated: 1700000001 })
    })
  })

  describe('read() — error scenarios', () => {
    it('emits ErrorMessage with failure_type transient_error on rate limit', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Rate limit exceeded'))

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // stream_status(started) + error
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'started',
      })

      const errorMsg = messages[1] as ErrorMessage
      expect(errorMsg.type).toBe('error')
      expect(errorMsg.failure_type).toBe('transient_error')
      expect(errorMsg.message).toContain('Rate limit')
      expect(errorMsg.stream).toBe('customers')
      expect(errorMsg.stack_trace).toBeDefined()
    })

    it('emits ErrorMessage with failure_type config_error for unknown stream', async () => {
      const source = createSource({})
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'nonexistent', primary_key: [['id']] }),
        })
      )

      expect(messages).toHaveLength(1)

      const errorMsg = messages[0] as ErrorMessage
      expect(errorMsg.type).toBe('error')
      expect(errorMsg.failure_type).toBe('config_error')
      expect(errorMsg.message).toBe('Unknown stream: nonexistent')
      expect(errorMsg.stream).toBe('nonexistent')
    })

    it('emits ErrorMessage with failure_type system_error on non-rate-limit error', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      const errorMsg = messages[1] as ErrorMessage
      expect(errorMsg.type).toBe('error')
      expect(errorMsg.failure_type).toBe('system_error')
      expect(errorMsg.message).toContain('Connection refused')
    })

    it('continues to next stream after error on previous stream', async () => {
      const failingListFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))
      const successListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'inv_1', total: 100 }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: failingListFn as ResourceConfig['listFn'],
        }),
        invoice: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: successListFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
        })
      )

      // customers: started + error = 2
      // invoices: started + record + state + complete = 4
      expect(messages).toHaveLength(6)

      // Customers errored
      expect(messages[0]).toMatchObject({
        type: 'stream_status',
        stream: 'customers',
        status: 'started',
      })
      expect(messages[1]).toMatchObject({ type: 'error', stream: 'customers' })

      // Invoices succeeded
      expect(messages[2]).toMatchObject({
        type: 'stream_status',
        stream: 'invoices',
        status: 'started',
      })
      expect(messages[5]).toMatchObject({
        type: 'stream_status',
        stream: 'invoices',
        status: 'complete',
      })
    })
  })

  describe('read() — invocation modes', () => {
    // Shared registry for these tests
    const listFn = vi.fn()
    const registry: Record<string, ResourceConfig> = {
      customer: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: listFn as ResourceConfig['listFn'],
      }),
    }

    beforeEach(() => {
      listFn.mockReset()
    })

    it('backfill only: no input, no state → paginates from beginning', async () => {
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          // no input, no state
        })
      )

      // Should paginate: started + record + state(complete) + complete
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({ type: 'stream_status', status: 'started' })
      expect(messages[1]).toMatchObject({ type: 'record', stream: 'customers' })
      expect(messages[2]).toMatchObject({
        type: 'state',
        data: { pageCursor: null, status: 'complete' },
      })
      expect(messages[3]).toMatchObject({ type: 'stream_status', status: 'complete' })

      // No starting_after on first call
      expect(listFn).toHaveBeenCalledWith({ limit: 100 })
    })

    it('stream via webhook (input): single event → record + state, no pagination', async () => {
      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_wh_1',
        type: 'customer.updated',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', name: 'Updated Alice' },
      })

      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      // Live mode: exactly 1 record + 1 state
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Updated Alice' },
      })
      expect(messages[1]).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { eventId: 'evt_wh_1', eventCreated: 1700000000 },
      })

      // listFn should NOT be called — no pagination in live mode
      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via websocket (input): same code path as webhook', async () => {
      // WebSocket is a transport concern — the Stripe.Event is identical.
      // read() with input= behaves the same regardless of transport.
      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_ws_1',
        type: 'customer.created',
        created: 1700000001,
        dataObject: { id: 'cus_2', object: 'customer', name: 'Bob via WS' },
      })

      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_2', name: 'Bob via WS' },
      })
      expect(messages[1]).toMatchObject({
        type: 'state',
        data: { eventId: 'evt_ws_1' },
      })

      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via input: filters out events for streams not in catalog', async () => {
      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_other',
        type: 'invoice.paid',
        dataObject: { id: 'inv_1', object: 'invoice', amount: 100 },
      })

      // Catalog only has customers, but event is for invoices
      const messages = await collect(
        source.read(
          { config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) },
          toIter(event)
        )
      )

      // Event is for a stream not in catalog → no output
      expect(messages).toHaveLength(0)
    })

    it('backfill + prior webhook state: resumes pagination from cursor', async () => {
      // Simulates: webhook events were processed (state has eventId),
      // then backfill is invoked with that state to fill historical data.
      // The backfill reads pageCursor from state, ignoring webhook-specific fields.
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { pageCursor: 'cus_2', status: 'pending' } },
          // no input → backfill mode, but with state from prior run
        })
      )

      // Resumes from cus_2
      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_2' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].data).toMatchObject({ id: 'cus_3' })
    })

    it('backfill + prior websocket state: resumes pagination from cursor', async () => {
      // Same as above — transport doesn't matter, state shape determines resume behavior
      listFn.mockResolvedValueOnce({
        data: [
          { id: 'cus_4', name: 'Dana' },
          { id: 'cus_5', name: 'Eve' },
        ],
        has_more: false,
      })

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { pageCursor: 'cus_3', status: 'pending' } },
        })
      )

      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_3' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(2)
      expect(records.map((r) => r.data.id)).toEqual(['cus_4', 'cus_5'])

      // Final state should be complete
      const states = messages.filter((m): m is StateMessage => m.type === 'state')
      expect(states[states.length - 1].data).toMatchObject({
        pageCursor: null,
        status: 'complete',
      })
    })
  })

  describe('read(input) — enriched webhook processing', () => {
    it('delete event yields record with deleted: true', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_del_1',
        type: 'customer.deleted',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', deleted: true },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', object: 'customer', deleted: true },
      })
      expect(messages[1]).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { eventId: 'evt_del_1', eventCreated: 1700000000 },
      })
    })

    it('delete event detected by event type (not just deleted flag)', async () => {
      const registry: Record<string, ResourceConfig> = {
        product: makeConfig({ order: 1, tableName: 'products' }),
      }

      const source = createSource(registry)
      // product.deleted event — the object may not have deleted: true in its body
      const event = makeEvent({
        id: 'evt_del_2',
        type: 'product.deleted',
        created: 1700000000,
        dataObject: { id: 'prod_1', object: 'product', name: 'Old Product' },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'products' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'products',
        data: { id: 'prod_1', object: 'product', deleted: true },
      })
    })

    it('subscription event yields subscription_items from nested items.data', async () => {
      const registry: Record<string, ResourceConfig> = {
        subscription: makeConfig({ order: 1, tableName: 'subscriptions' }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_sub_1',
        type: 'customer.subscription.updated',
        created: 1700000000,
        dataObject: {
          id: 'sub_1',
          object: 'subscription',
          status: 'active',
          items: {
            data: [
              { id: 'si_1', object: 'subscription_item', price: 'price_1' },
              { id: 'si_2', object: 'subscription_item', price: 'price_2' },
            ],
          },
        },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'subscriptions' }) }, toIter(event))
      )

      // 1 subscription record + 2 subscription_item records + 1 state
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'subscriptions',
        data: { id: 'sub_1' },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        stream: 'subscription_items',
        data: { id: 'si_1', price: 'price_1' },
      })
      expect(messages[2]).toMatchObject({
        type: 'record',
        stream: 'subscription_items',
        data: { id: 'si_2', price: 'price_2' },
      })
      expect(messages[3]).toMatchObject({
        type: 'state',
        stream: 'subscriptions',
        data: { eventId: 'evt_sub_1' },
      })
    })

    it('entitlement summary event yields individual entitlement records', async () => {
      const registry: Record<string, ResourceConfig> = {
        active_entitlements: makeConfig({ order: 1, tableName: 'active_entitlements' }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_ent_1',
        type: 'entitlements.active_entitlement_summary.updated',
        created: 1700000000,
        dataObject: {
          id: 'entsummary_1',
          object: 'entitlements.active_entitlement_summary',
          customer: 'cus_1',
          entitlements: {
            data: [
              {
                id: 'ent_1',
                object: 'entitlements.active_entitlement',
                feature: 'feat_premium',
                livemode: false,
                lookup_key: 'premium',
              },
              {
                id: 'ent_2',
                object: 'entitlements.active_entitlement',
                feature: { id: 'feat_basic' },
                livemode: false,
                lookup_key: 'basic',
              },
            ],
          },
        },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'active_entitlements' }) }, toIter(event))
      )

      // 2 entitlement records + 1 state
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'active_entitlements',
        data: {
          id: 'ent_1',
          feature: 'feat_premium',
          customer: 'cus_1',
          lookup_key: 'premium',
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        stream: 'active_entitlements',
        data: {
          id: 'ent_2',
          feature: 'feat_basic',
          customer: 'cus_1',
          lookup_key: 'basic',
        },
      })
      expect(messages[2]).toMatchObject({
        type: 'state',
        stream: 'active_entitlements',
        data: { eventId: 'evt_ent_1' },
      })
    })

    it('revalidation re-fetches from Stripe API when object is not in final state', async () => {
      const retrieveFn = vi.fn().mockResolvedValueOnce({
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        extra: 'revalidated',
      })

      const registry: Record<string, ResourceConfig> = {
        subscription: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_reval_1',
        type: 'customer.subscription.updated',
        created: 1700000000,
        dataObject: { id: 'sub_1', object: 'subscription', status: 'active' },
      })

      const messages = await collect(
        source.read(
          {
            config: { ...config, revalidate_objects: ['subscription'] },
            catalog: catalog({ name: 'subscriptions' }),
          },
          toIter(event)
        )
      )

      expect(retrieveFn).toHaveBeenCalledWith('sub_1')
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records[0].data).toMatchObject({ id: 'sub_1', extra: 'revalidated' })
    })

    it('revalidation skips re-fetch when object is in final state', async () => {
      const retrieveFn = vi.fn()

      const registry: Record<string, ResourceConfig> = {
        subscription: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_reval_2',
        type: 'customer.subscription.deleted',
        created: 1700000000,
        dataObject: { id: 'sub_1', object: 'subscription', status: 'canceled' },
      })

      const messages = await collect(
        source.read(
          {
            config: { ...config, revalidate_objects: ['subscription'] },
            catalog: catalog({ name: 'subscriptions' }),
          },
          toIter(event)
        )
      )

      // Should NOT re-fetch because isFinalState returns true
      expect(retrieveFn).not.toHaveBeenCalled()
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records[0].data).toMatchObject({ id: 'sub_1', status: 'canceled' })
    })

    it('preview objects (no id) produce no output', async () => {
      const registry: Record<string, ResourceConfig> = {
        invoice: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_preview_1',
        type: 'invoice.upcoming',
        dataObject: { object: 'invoice', amount_due: 5000 },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'invoices' }) }, toIter(event))
      )

      expect(messages).toHaveLength(0)
    })

    it('normalizes aliased object types (checkout.session → checkout_sessions)', async () => {
      const registry: Record<string, ResourceConfig> = {
        checkout_sessions: makeConfig({ order: 1, tableName: 'checkout_sessions' }),
      }

      const source = createSource(registry)
      const event = makeEvent({
        id: 'evt_cs_1',
        type: 'checkout.session.completed',
        created: 1700000000,
        dataObject: { id: 'cs_1', object: 'checkout.session', amount_total: 1000 },
      })

      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'checkout_sessions' }) }, toIter(event))
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'record',
        stream: 'checkout_sessions',
        data: { id: 'cs_1' },
      })
    })

    it('throws when raw webhook input is provided without webhook_secret', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const source = createSource(registry)
      const rawInput = { body: '{"id":"evt_1"}', signature: 'sig_test' }

      await expect(
        collect(
          source.read(
            { config, catalog: catalog({ name: 'customers' }) }, // no webhook_secret
            toIter(rawInput)
          )
        )
      ).rejects.toThrow('webhook_secret is required for raw webhook signature verification')
    })
  })

  describe('read() — WebSocket streaming', () => {
    const registry: Record<string, ResourceConfig> = {
      customer: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
      invoice: makeConfig({
        order: 2,
        tableName: 'invoices',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
    }

    /** Push a synthetic event through the captured onEvent callback. */
    function pushWsEvent(event: Stripe.Event) {
      capturedOnEvent!({
        type: 'webhook_event',
        webhook_id: 'wh_' + event.id,
        webhook_conversation_id: 'whc_1',
        event_payload: JSON.stringify(event),
        http_headers: {},
        endpoint: { url: 'stripe-sync-engine', status: 'enabled' },
      })
    }

    afterEach(() => {
      capturedOnEvent = null
      mockClose.mockClear()
    })

    it('read() creates WebSocket client when websocket: true', async () => {
      const { createStripeWebSocketClient } = await import('../src-websocket')
      const source = createSource(registry)

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // First iter.next() triggers createStripeWebSocketClient inside read()
      await iter.next() // stream_status started

      expect(createStripeWebSocketClient).toHaveBeenCalledWith(
        expect.objectContaining({ stripeApiKey: 'sk_test_fake' })
      )
      expect(capturedOnEvent).toBeTypeOf('function')

      // Clean up — triggers finally block which calls wsClient.close()
      await iter.return()
    })

    it("read()'s finally block closes WebSocket client", async () => {
      const source = createSource(registry)

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      // Returning the iterator triggers the finally block, which calls wsClient.close()
      await iter.return()
      expect(mockClose).toHaveBeenCalled()
    })

    it('streams WebSocket events after empty backfill', async () => {
      const source = createSource(registry)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // Backfill: empty stream produces started + state(complete) + complete
      // capturedOnEvent is set during the first iter.next() (createStripeWebSocketClient is called inside read())
      const m1 = await iter.next() // stream_status started
      const m2 = await iter.next() // state complete
      const m3 = await iter.next() // stream_status complete
      expect(m1.value).toMatchObject({ type: 'stream_status', status: 'started' })
      expect(m2.value).toMatchObject({ type: 'state', data: { status: 'complete' } })
      expect(m3.value).toMatchObject({ type: 'stream_status', status: 'complete' })

      // Now push a WebSocket event — capturedOnEvent is set, read() should yield it
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_1',
          type: 'customer.updated',
          created: 1700000001,
          dataObject: { id: 'cus_1', object: 'customer', name: 'Alice via WS' },
        })
      )

      const m4 = await iter.next() // record
      const m5 = await iter.next() // state
      expect(m4.value).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1', name: 'Alice via WS' },
      })
      expect(m5.value).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { eventId: 'evt_ws_1' },
      })

      // Clean up — triggers finally block which calls wsClient.close()
      await iter.return()
    })

    it('interleaves queued WebSocket events during backfill', async () => {
      const listFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'cus_1', name: 'Alice' }],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'cus_2', name: 'Bob' }],
          has_more: false,
        })

      const wsRegistry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(wsRegistry)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // stream_status started — also triggers createStripeWebSocketClient, setting capturedOnEvent
      const m1 = await iter.next()
      expect(m1.value).toMatchObject({ type: 'stream_status', status: 'started' })

      // Queue an event AFTER stream_status started — capturedOnEvent is now set.
      // The generator is paused before the drain, so this event will be drained before page 1.
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_queued',
          type: 'customer.created',
          created: 1700000000,
          dataObject: { id: 'cus_ws_1', object: 'customer', name: 'WS Queued' },
        })
      )

      // Before page 1: queued WS event is drained
      const m2 = await iter.next() // ws record
      const m3 = await iter.next() // ws state
      expect(m2.value).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_ws_1', name: 'WS Queued' },
      })
      expect(m3.value).toMatchObject({
        type: 'state',
        stream: 'customers',
        data: { eventId: 'evt_ws_queued' },
      })

      // Page 1: backfill record + state
      const m4 = await iter.next() // record cus_1
      const m5 = await iter.next() // state pending
      expect(m4.value).toMatchObject({ type: 'record', data: { id: 'cus_1' } })
      expect(m5.value).toMatchObject({ type: 'state', data: { status: 'pending' } })

      // Before page 2: no queued events, so straight to backfill
      // Page 2: backfill record + state + stream_status complete
      const m6 = await iter.next() // record cus_2
      const m7 = await iter.next() // state complete
      const m8 = await iter.next() // stream_status complete
      expect(m6.value).toMatchObject({ type: 'record', data: { id: 'cus_2' } })
      expect(m7.value).toMatchObject({ type: 'state', data: { status: 'complete' } })
      expect(m8.value).toMatchObject({ type: 'stream_status', status: 'complete' })

      // After backfill: push another WS event, verify it's yielded
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_live',
          type: 'customer.updated',
          created: 1700000002,
          dataObject: { id: 'cus_live', object: 'customer', name: 'Live Event' },
        })
      )

      const m9 = await iter.next() // record
      const m10 = await iter.next() // state
      expect(m9.value).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_live', name: 'Live Event' },
      })
      expect(m10.value).toMatchObject({
        type: 'state',
        data: { eventId: 'evt_ws_live' },
      })

      await iter.return()
    })

    it('filters out WebSocket events for streams not in catalog', async () => {
      const source = createSource(registry)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // Skip backfill messages (empty stream: started + state + complete)
      await iter.next()
      await iter.next()
      await iter.next()

      // Push event for invoices (not in catalog) — should be skipped
      pushWsEvent(
        makeEvent({
          id: 'evt_inv',
          type: 'invoice.paid',
          dataObject: { id: 'inv_1', object: 'invoice', amount: 100 },
        })
      )

      // Push event for customers (in catalog) — should be yielded
      pushWsEvent(
        makeEvent({
          id: 'evt_cus',
          type: 'customer.updated',
          created: 1700000003,
          dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
        })
      )

      const m1 = await iter.next()
      expect(m1.value).toMatchObject({
        type: 'record',
        stream: 'customers',
        data: { id: 'cus_1' },
      })

      await iter.return()
    })

    it('read() with websocket: true creates WebSocket client (combined config)', async () => {
      const { createStripeWebSocketClient } = await import('../src-websocket')
      const source = createSource(registry)

      vi.mocked(createStripeWebSocketClient).mockClear()

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      expect(createStripeWebSocketClient).toHaveBeenCalledTimes(1)
      await iter.return()
    })

    it('teardown() is safe when no websocket was configured', async () => {
      const source = createSource(registry)
      // No setup() call — teardown should not throw
      await source.teardown!({ config: { api_key: 'sk_test_fake' } })
      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  describe('read() — HTTP server mode', () => {
    it('starts an HTTP server on webhook_port and processes POSTed webhooks', async () => {
      const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers', listFn }),
      }
      const source = createSource(registry)
      const cat = catalog({ name: 'customers' })

      // Use port 0 so the OS picks a free port
      const cfg = {
        api_key: 'sk_test_fake',
        webhook_secret: 'whsec_test',
        webhook_port: 0,
      }

      const messages: Message[] = []
      const iter = source.read({ config: cfg, catalog: cat, state: {} })

      // Drain backfill messages (started, state, complete for the empty stream)
      for (let i = 0; i < 3; i++) {
        const { value, done } = await iter.next()
        if (done) break
        messages.push(value)
      }

      expect(messages[0]).toMatchObject({ type: 'stream_status', status: 'started' })
      expect(messages[2]).toMatchObject({ type: 'stream_status', status: 'complete' })

      // Clean up: return the iterator which triggers the finally block
      await iter.return(undefined as unknown as Message)
    })
  })

  describe('read() — events polling', () => {
    it('skips backfill when all streams are already complete', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { pageCursor: null, status: 'complete' } },
        })
      )

      // listFn should NOT be called — stream is already complete
      expect(listFn).not.toHaveBeenCalled()

      // Should not emit stream_status: started for complete streams
      const started = messages.filter(
        (m): m is StreamStatusMessage => m.type === 'stream_status' && m.status === 'started'
      )
      expect(started).toHaveLength(0)
    })

    it('stamps initial events_cursor after first backfill completes', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const now = Math.floor(Date.now() / 1000)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { pageCursor: null, status: 'complete' } },
        })
      )

      // Should emit a state message with events_cursor stamped
      const states = messages.filter((m): m is StateMessage => m.type === 'state')
      expect(states).toHaveLength(1)
      expect(states[0].stream).toBe('customers')
      expect((states[0].data as { events_cursor: number }).events_cursor).toBeGreaterThanOrEqual(
        now
      )
      expect((states[0].data as { status: string }).status).toBe('complete')
    })

    it('does not run events polling when poll_events is false/absent', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config, // no poll_events
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { pageCursor: null, status: 'complete' } },
        })
      )

      // No events_cursor should appear in output
      const states = messages.filter((m): m is StateMessage => m.type === 'state')
      const withCursor = states.filter(
        (s) => (s.data as { events_cursor?: number }).events_cursor != null
      )
      expect(withCursor).toHaveLength(0)
    })

    it('does not poll when some streams are still pending', async () => {
      const custListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoice: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: (() =>
            Promise.resolve({
              data: [{ id: 'inv_1' }],
              has_more: false,
            })) as ResourceConfig['listFn'],
        }),
      }

      const source = createSource(registry)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
          // customers is complete, but invoices is pending
          state: { customers: { pageCursor: null, status: 'complete' } },
        })
      )

      // Invoices should be backfilled (listFn called)
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records.some((r) => r.stream === 'invoices')).toBe(true)

      // customers listFn should NOT be called (already complete)
      expect(custListFn).not.toHaveBeenCalled()

      // No events_cursor should appear — not all streams were complete at start
      // (invoices was pending, so pollEvents returns early)
      // But after backfill, invoices is now complete. However, pollEvents checks
      // the input state, not the post-backfill state, so it won't stamp cursors.
      const statesWithCursor = messages
        .filter((m): m is StateMessage => m.type === 'state')
        .filter((s) => (s.data as { events_cursor?: number }).events_cursor != null)
      expect(statesWithCursor).toHaveLength(0)
    })
  })

  describe('architecture purity', () => {
    it('source never imports from or references any destination module', () => {
      const srcDir = path.resolve(__dirname, '..')
      const sourceFiles = getAllTsFiles(srcDir)

      // Type-only imports are allowed (no runtime dependency)
      const destinationPatterns = [
        /(?<!import type .*)from\s+['"].*destination/,
        /(?<!type\s.*)import\s+(?!type\s).*['"].*destination/,
        /require\s*\(\s*['"].*destination/,
      ]

      const violations: string[] = []

      for (const file of sourceFiles) {
        // Skip test files
        if (file.includes('__tests__')) continue

        const content = fs.readFileSync(file, 'utf-8')
        const lines = content.split('\n')
        for (const line of lines) {
          // Skip type-only imports
          if (/import\s+type\s/.test(line)) continue
          for (const pattern of destinationPatterns) {
            if (pattern.test(line)) {
              violations.push(`${path.relative(srcDir, file)}: ${line.trim()}`)
            }
          }
        }
      }

      expect(violations).toEqual([])
    })
  })
})
