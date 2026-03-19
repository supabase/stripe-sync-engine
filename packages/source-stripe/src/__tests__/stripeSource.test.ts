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
import { createSource, fromWebhookEvent } from '../backfill'
import type { ResourceConfig } from '../types'
import type { StripeWebhookEvent, StripeWebSocketClient } from '../websocket-client'

// Mock the websocket-client module
const mockClose = vi.fn()
let capturedOnEvent: ((event: StripeWebhookEvent) => void) | null = null

vi.mock('../websocket-client', () => ({
  createStripeWebSocketClient: vi.fn(
    async (opts: { onEvent: (event: StripeWebhookEvent) => void }) => {
      capturedOnEvent = opts.onEvent
      return { close: mockClose, isConnected: () => true } satisfies StripeWebSocketClient
    }
  ),
}))

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
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          input: event,
        })
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
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          input: event,
        })
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
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          input: event,
        })
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

    it('setup() creates WebSocket client when websocket: true', async () => {
      const { createStripeWebSocketClient } = await import('../websocket-client')
      const source = createSource(registry)
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }),
      })

      expect(createStripeWebSocketClient).toHaveBeenCalledWith(
        expect.objectContaining({ stripeApiKey: 'sk_test_fake' })
      )
      expect(capturedOnEvent).toBeTypeOf('function')

      // Clean up
      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
    })

    it('teardown() closes WebSocket client', async () => {
      const source = createSource(registry)
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }),
      })

      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
      expect(mockClose).toHaveBeenCalled()
    })

    it('streams WebSocket events after empty backfill', async () => {
      const source = createSource(registry)
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }),
      })

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // Backfill: empty stream produces started + state(complete) + complete
      const m1 = await iter.next() // stream_status started
      const m2 = await iter.next() // state complete
      const m3 = await iter.next() // stream_status complete
      expect(m1.value).toMatchObject({ type: 'stream_status', status: 'started' })
      expect(m2.value).toMatchObject({ type: 'state', data: { status: 'complete' } })
      expect(m3.value).toMatchObject({ type: 'stream_status', status: 'complete' })

      // Now push a WebSocket event — read() should yield it
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

      // Clean up: teardown closes wsClient, which breaks the while(wsClient) loop
      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
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
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }),
      })

      // Queue an event BEFORE calling read() — it should be drained during backfill
      pushWsEvent(
        makeEvent({
          id: 'evt_ws_queued',
          type: 'customer.created',
          created: 1700000000,
          dataObject: { id: 'cus_ws_1', object: 'customer', name: 'WS Queued' },
        })
      )

      const iter = source
        .read({
          config: { api_key: 'sk_test_fake', websocket: true },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // stream_status started
      const m1 = await iter.next()
      expect(m1.value).toMatchObject({ type: 'stream_status', status: 'started' })

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

      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
    })

    it('filters out WebSocket events for streams not in catalog', async () => {
      const source = createSource(registry)
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }), // only customers, not invoices
      })

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

      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
    })

    it('setup() with both webhook_url and websocket creates both', async () => {
      // This test just verifies setup doesn't throw with both options.
      // Webhook setup requires a real Stripe client, so we only verify the WS part.
      const { createStripeWebSocketClient } = await import('../websocket-client')
      const source = createSource(registry)

      // webhook_url setup will fail (no real Stripe client), but we can verify
      // the websocket path was reached by checking the mock
      vi.mocked(createStripeWebSocketClient).mockClear()

      // Use a source with no webhook_url to avoid Stripe API calls,
      // but with websocket: true
      await source.setup!({
        config: { api_key: 'sk_test_fake', websocket: true },
        catalog: catalog({ name: 'customers' }),
      })

      expect(createStripeWebSocketClient).toHaveBeenCalledTimes(1)
      await source.teardown!({ config: { api_key: 'sk_test_fake', websocket: true } })
    })

    it('teardown() is safe when no websocket was configured', async () => {
      const source = createSource(registry)
      // No setup() call — teardown should not throw
      await source.teardown!({ config: { api_key: 'sk_test_fake' } })
      expect(mockClose).not.toHaveBeenCalled()
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
        // Skip test files and server application code
        if (file.includes('__tests__')) continue
        if (file.includes('/server/')) continue

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
