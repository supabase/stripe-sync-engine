import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StripeEvent } from './spec.js'
import { StripeRequestError, type StripeClient } from './client.js'
import type {
  ConfiguredCatalog,
  Message,
  RecordMessage,
  SourceStateMessage,
  TraceMessage,
} from '@stripe/sync-protocol'
import { collectFirst, drain } from '@stripe/sync-protocol'
import source, { createStripeSource, discoverCache } from './index.js'
import { fromStripeEvent } from './process-event.js'
import { buildResourceRegistry } from './resourceRegistry.js'
import type { ResourceConfig } from './types.js'
import type { StripeWebhookEvent, StripeWebSocketClient } from './src-websocket.js'
import type { SegmentState, StripeStreamState } from './index.js'
import { listApiBackfill } from './src-list-api.js'
import { createInMemoryRateLimiter } from './rate-limiter.js'
import type { RateLimiter } from './rate-limiter.js'

// Mock the WebSocket module
const mockClose = vi.fn()
let capturedOnEvent: ((event: StripeWebhookEvent) => void) | null = null
const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined)
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

vi.mock('./src-websocket', () => ({
  createStripeWebSocketClient: vi.fn(
    async (opts: { onEvent: (event: StripeWebhookEvent) => void }) => {
      capturedOnEvent = opts.onEvent
      return { close: mockClose, isConnected: () => true } satisfies StripeWebSocketClient
    }
  ),
}))

vi.mock('./resourceRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./resourceRegistry.js')>()),
  buildResourceRegistry: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.js')>()),
  makeClient: vi.fn(() => ({
    getAccount: vi.fn(async () => ({ id: 'acct_test_fake123' })),
  })),
}))

/** Wrap a single item as an AsyncIterable for source.read()'s $stdin param. */
async function* toIter<T>(item: T): AsyncIterable<T> {
  yield item
}

function makeConfig(
  overrides: Partial<ResourceConfig> & { order: number; tableName: string }
): ResourceConfig {
  return {
    supportsCreatedFilter: false,
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

/** Create a minimal StripeEvent for testing fromStripeEvent(). */
function makeEvent(overrides: {
  id?: string
  type?: string
  created?: number
  dataObject: Record<string, unknown>
}): StripeEvent {
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
      object: overrides.dataObject,
    },
  } satisfies StripeEvent
}

const config = { api_key: 'sk_test_fake', api_version: '2025-04-30.basil' as const }

beforeEach(() => {
  vi.mocked(buildResourceRegistry).mockReset()
  discoverCache.clear()
  consoleInfo.mockClear()
  consoleError.mockClear()
})

describe('StripeSource', () => {
  describe('discover()', () => {
    it('returns a CatalogMessage with known streams', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
        invoices: makeConfig({ order: 2, tableName: 'invoices' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toHaveLength(2)
      expect(cat.streams.map((s) => s.name)).toEqual(['customers', 'invoices'])
    })

    it('excludes resources with sync: false', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
        internal: makeConfig({ order: 2, tableName: 'internal', sync: false }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toHaveLength(1)
      expect(cat.streams[0].name).toBe('customers')
    })

    it('returns empty streams for empty registry', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue({} as any)
      const cat = (await collectFirst(source.discover({ config }), 'catalog')).catalog

      expect(cat.streams).toEqual([])
    })
  })

  describe('read() — backfill scenarios', () => {
    it('emits RecordMessage + SourceStateMessage in correct interleaving for multi-page stream', async () => {
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
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // Expected sequence:
      // 1. trace(stream_status started)
      // 2. record(cus_1)
      // 3. record(cus_2)
      // 4. state(page_cursor: cus_2, status: pending)
      // 5. record(cus_3)
      // 6. state(page_cursor: null, status: complete)
      // 7. trace(stream_status complete)
      expect(messages).toHaveLength(7)

      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'started' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_1', name: 'Alice' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_2', name: 'Bob' } },
      })
      expect(messages[3]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { page_cursor: 'cus_2', status: 'pending' } },
      })
      expect(messages[4]).toMatchObject({
        type: 'record',
        record: { stream: 'customers', data: { id: 'cus_3', name: 'Charlie' } },
      })
      expect(messages[5]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { page_cursor: null, status: 'complete' } },
      })
      expect(messages[6]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'complete' } },
      })

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
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: invListFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'started' },
        },
      })
      expect(messages[1]).toMatchObject({ type: 'record', record: { stream: 'customers' } })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers' },
      })
      expect(messages[3]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'complete' },
        },
      })

      // Then invoices
      expect(messages[4]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'started' },
        },
      })
      expect(messages[5]).toMatchObject({ type: 'record', record: { stream: 'invoices' } })
      expect(messages[6]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'invoices' },
      })
      expect(messages[7]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'complete' },
        },
      })
    })

    it('resumes from prior state cursor without re-emitting checkpointed records', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const priorState = {
        streams: { customers: { page_cursor: 'cus_2', status: 'pending' } },
        global: {},
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
      expect(records[0].record.data).toMatchObject({ id: 'cus_3' })
    })

    it('handles empty stream (listFn returns no data)', async () => {
      const listFn = vi.fn().mockResolvedValueOnce({
        data: [],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // trace(stream_status started) + state(complete) + trace(stream_status complete)
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'started' },
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { page_cursor: null, status: 'complete' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'complete' },
        },
      })
    })

    // Covered by WebSocket streaming tests below — backfill + ws interleaved
    // test verifies this transition end-to-end.
  })

  describe('fromStripeEvent() — live mode scenarios', () => {
    it('webhook mode emits one RecordMessage + one SourceStateMessage per event', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        id: 'evt_1abc',
        type: 'customer.updated',
        created: 1700000000,
        dataObject: { id: 'cus_1', object: 'customer', name: 'Alice' },
      })

      const result = fromStripeEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.type).toBe('record')
      expect(result!.record.record.stream).toBe('customers')
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        name: 'Alice',
      })
      expect(result!.record.record.emitted_at).toBeTypeOf('string')

      expect(result!.state.type).toBe('source_state')
      expect(result!.state.source_state.stream).toBe('customers')
      expect(result!.state.source_state.data).toEqual({
        eventId: 'evt_1abc',
        eventCreated: 1700000000,
      })
    })

    it('returns null for unsupported object type', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'unknown_1', object: 'unknown_type' },
      })

      const result = fromStripeEvent(event, registry)
      expect(result).toBeNull()
    })

    it('returns null for objects without id (preview/draft)', () => {
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        type: 'invoice.upcoming',
        dataObject: { object: 'invoice', amount_due: 5000 },
      })

      const result = fromStripeEvent(event, registry)
      expect(result).toBeNull()
    })

    it('passes through deleted flag from event data', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        type: 'customer.deleted',
        dataObject: { id: 'cus_1', object: 'customer', deleted: true },
      })

      const result = fromStripeEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.record.data).toMatchObject({
        id: 'cus_1',
        object: 'customer',
        deleted: true,
      })
    })

    it('returns null when event data.object has no object field', () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      const event = makeEvent({
        dataObject: { id: 'cus_1' },
      })

      const result = fromStripeEvent(event, registry)
      expect(result).toBeNull()
    })

    it('WebSocket mode uses same fromStripeEvent conversion as webhook mode', () => {
      // WebSocket is a transport concern — the conversion is identical.
      // The same StripeEvent structure is received regardless of transport.
      // This test verifies fromStripeEvent works for any StripeEvent input.
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      const event = makeEvent({
        id: 'evt_ws_1',
        type: 'invoice.paid',
        created: 1700000001,
        dataObject: { id: 'inv_1', object: 'invoice', amount_paid: 1000 },
      })

      const result = fromStripeEvent(event, registry)

      expect(result).not.toBeNull()
      expect(result!.record.record.stream).toBe('invoices')
      expect(result!.record.record.data).toMatchObject({ id: 'inv_1', amount_paid: 1000 })
      expect(result!.state.source_state.data).toEqual({
        eventId: 'evt_ws_1',
        eventCreated: 1700000001,
      })
    })
  })

  describe('read() — error scenarios', () => {
    it('emits TraceMessage error with failure_type transient_error on rate limit', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Rate limit exceeded'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      // trace(stream_status started) + trace(error) + source_state(transient_error)
      expect(messages).toHaveLength(3)
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'started' },
        },
      })

      const errorMsg = messages[1] as TraceMessage
      expect(errorMsg.type).toBe('trace')
      expect(errorMsg.trace.trace_type).toBe('error')
      const traceError = (
        errorMsg.trace as {
          trace_type: 'error'
          error: { failure_type: string; message: string; stream?: string; stack_trace?: string }
        }
      ).error
      expect(traceError.failure_type).toBe('transient_error')
      expect(traceError.message).toContain('Rate limit')
      expect(traceError.stream).toBe('customers')
      expect(traceError.stack_trace).toBeDefined()

      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'customers',
          data: { status: 'transient_error' },
        },
      })
    })

    it('emits TraceMessage error with failure_type config_error for unknown stream', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue({} as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'nonexistent', primary_key: [['id']] }),
        })
      )

      expect(messages).toHaveLength(2)

      const errorMsg = messages[0] as TraceMessage
      expect(errorMsg.type).toBe('trace')
      expect(errorMsg.trace.trace_type).toBe('error')
      const traceError = (
        errorMsg.trace as {
          trace_type: 'error'
          error: { failure_type: string; message: string; stream?: string }
        }
      ).error
      expect(traceError.failure_type).toBe('config_error')
      expect(traceError.message).toBe('Unknown stream: nonexistent')
      expect(traceError.stream).toBe('nonexistent')

      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'nonexistent',
          data: { status: 'config_error' },
        },
      })
    })

    it('emits TraceMessage error with failure_type system_error on non-rate-limit error', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(3)
      const errorMsg = messages[1] as TraceMessage
      expect(errorMsg.type).toBe('trace')
      expect(errorMsg.trace.trace_type).toBe('error')
      const traceError = (
        errorMsg.trace as { trace_type: 'error'; error: { failure_type: string; message: string } }
      ).error
      expect(traceError.failure_type).toBe('system_error')
      expect(traceError.message).toContain('Connection refused')

      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'customers',
          data: { status: 'system_error' },
        },
      })
    })

    it('emits TraceMessage error when getAccount fails before parallel backfill pagination', async () => {
      const listFn = vi.fn()

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi.fn().mockRejectedValueOnce(
          new StripeRequestError(
            401,
            {
              error: {
                type: 'invalid_request_error',
                message: 'Invalid API Key provided: sk_test_bad',
              },
            },
            'GET',
            '/v1/account'
          )
        ),
      } as unknown as StripeClient

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter: async () => 0,
        })
      )

      expect(messages).toHaveLength(3)
      expect(listFn).not.toHaveBeenCalled()
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'started' },
        },
      })

      const errorMsg = messages[1] as TraceMessage
      expect(errorMsg.trace.trace_type).toBe('error')
      const traceError = (
        errorMsg.trace as {
          trace_type: 'error'
          error: { failure_type: string; message: string; stream?: string }
        }
      ).error
      expect(traceError.failure_type).toBe('auth_error')
      expect(traceError.message).toContain('Invalid API Key')
      expect(traceError.stream).toBe('customers')

      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'customers', data: { status: 'auth_error' } },
      })
    })

    it('emits TraceMessage error for Invalid API Key on sequential streams', async () => {
      const listFn = vi.fn().mockRejectedValueOnce(
        new StripeRequestError(
          401,
          {
            error: {
              type: 'invalid_request_error',
              message: 'Invalid API Key provided: sk_test_bad',
            },
          },
          'GET',
          '/v1/tax_ids'
        )
      )

      const registry: Record<string, ResourceConfig> = {
        tax_ids: makeConfig({
          order: 1,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'tax_ids', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(3)
      const errorMsg = messages[1] as TraceMessage
      expect(errorMsg.trace.trace_type).toBe('error')
      const traceError = (
        errorMsg.trace as {
          trace_type: 'error'
          error: { failure_type: string; message: string; stream?: string }
        }
      ).error
      expect(traceError.failure_type).toBe('auth_error')
      expect(traceError.message).toContain('Invalid API Key')
      expect(traceError.stream).toBe('tax_ids')

      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { state_type: 'stream', stream: 'tax_ids', data: { status: 'auth_error' } },
      })
    })

    it('does not treat near-miss auth errors as skippable', async () => {
      const listFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Authentication failed: must provide a valid API key'))

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'customers', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(3)
      expect(messages[1]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'error',
          error: {
            failure_type: 'system_error',
            stream: 'customers',
          },
        },
      })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'customers',
          data: { status: 'system_error' },
        },
      })
    })

    it('marks known skippable Stripe list errors as complete without emitting error traces', async () => {
      const listFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('This object is only available in testmode'))

      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({
          order: 1,
          tableName: 'invoices',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({ config, catalog: catalog({ name: 'invoices', primary_key: [['id']] }) })
      )

      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'started' },
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'complete' },
        },
      })
    })

    it('continues to next stream after error on previous stream', async () => {
      const failingListFn = vi.fn().mockRejectedValueOnce(new Error('Connection refused'))
      const successListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'inv_1', total: 100 }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: failingListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: successListFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
        })
      )

      // customers: started + error + error_state = 3
      // invoices: started + record + state + complete = 4
      expect(messages).toHaveLength(7)

      // Customers errored
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'started' },
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'error', error: { stream: 'customers' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: {
          state_type: 'stream',
          stream: 'customers',
          data: { status: 'system_error' },
        },
      })

      // Invoices succeeded
      expect(messages[3]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'started' },
        },
      })
      expect(messages[6]).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'invoices', status: 'complete' },
        },
      })
    })
  })

  describe('read() — error state persistence and skip/retry', () => {
    const skipListFn = vi.fn()
    const skipRegistry: Record<string, ResourceConfig> = {
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: skipListFn as ResourceConfig['listFn'],
      }),
    }

    beforeEach(() => {
      skipListFn.mockReset()
      vi.mocked(buildResourceRegistry).mockReturnValue(skipRegistry as any)
    })

    it('skips streams with auth_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'auth_error' },
            },
            global: {},
          },
        })
      )

      expect(messages).toHaveLength(0)
      expect(skipListFn).not.toHaveBeenCalled()
    })

    it('skips streams with system_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'system_error' },
            },
            global: {},
          },
        })
      )

      expect(messages).toHaveLength(0)
      expect(skipListFn).not.toHaveBeenCalled()
    })

    it('skips streams with config_error state (permanent)', async () => {
      skipListFn.mockResolvedValueOnce({ data: [{ id: 'cus_1' }], has_more: false })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'config_error' },
            },
            global: {},
          },
        })
      )

      expect(messages).toHaveLength(0)
      expect(skipListFn).not.toHaveBeenCalled()
    })

    it('retries streams with transient_error state (same as pending)', async () => {
      skipListFn.mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: {
              customers: { page_cursor: null, status: 'transient_error' },
            },
            global: {},
          },
        })
      )

      expect(skipListFn).toHaveBeenCalled()
      expect(messages.some((m) => m.type === 'record')).toBe(true)
      expect(messages.at(-1)).toMatchObject({
        type: 'trace',
        trace: {
          trace_type: 'stream_status',
          stream_status: { stream: 'customers', status: 'complete' },
        },
      })
    })

    it('preserves backfill progress in error state for later resume', async () => {
      const failAfterOne = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'cus_1', created: 1400000000 }],
          has_more: true,
        })
        .mockRejectedValueOnce(new Error('Connection refused'))

      const failRegistry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: false,
          listFn: failAfterOne as ResourceConfig['listFn'],
        }),
      }
      vi.mocked(buildResourceRegistry).mockReturnValue(failRegistry as any)

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
        })
      )

      const errorState = messages.find(
        (m) =>
          m.type === 'source_state' &&
          (m as any).source_state.stream === 'customers' &&
          (m as any).source_state.data.status === 'system_error'
      ) as any
      expect(errorState).toBeDefined()
      // page_cursor reflects the last checkpointed state, not the mid-pagination
      // cursor — the sequential paginator's local cursor is lost on error
      expect(errorState.source_state.data.page_cursor).toBeNull()
    })
  })

  describe('read() — invocation modes', () => {
    // Shared registry for these tests
    const listFn = vi.fn()
    const registry: Record<string, ResourceConfig> = {
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: listFn as ResourceConfig['listFn'],
      }),
    }

    beforeEach(() => {
      listFn.mockReset()
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
    })

    it('backfill only: no input, no state → paginates from beginning', async () => {
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          // no input, no state
        })
      )

      // Should paginate: started + record + state(complete) + complete
      expect(messages).toHaveLength(4)
      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'started' } },
      })
      expect(messages[1]).toMatchObject({ type: 'record', record: { stream: 'customers' } })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { data: { page_cursor: null, status: 'complete' } },
      })
      expect(messages[3]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'complete' } },
      })

      // No starting_after on first call
      expect(listFn).toHaveBeenCalledWith({ limit: 100 })
    })

    it('stream via webhook (input): single event → record + state, no pagination', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'customers', data: { id: 'cus_1', name: 'Updated Alice' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { eventId: 'evt_wh_1', eventCreated: 1700000000 },
        },
      })

      // listFn should NOT be called — no pagination in live mode
      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via websocket (input): same code path as webhook', async () => {
      // WebSocket is a transport concern — the StripeEvent is identical.
      // read() with input= behaves the same regardless of transport.
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'customers', data: { id: 'cus_2', name: 'Bob via WS' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: { data: { eventId: 'evt_ws_1' } },
      })

      expect(listFn).not.toHaveBeenCalled()
    })

    it('stream via input: filters out events for streams not in catalog', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
      // The backfill reads page_cursor from state, ignoring webhook-specific fields.
      listFn.mockResolvedValueOnce({
        data: [{ id: 'cus_3', name: 'Charlie' }],
        has_more: false,
      })

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: { customers: { page_cursor: 'cus_2', status: 'pending' } },
            global: {},
          },
          // no input → backfill mode, but with state from prior run
        })
      )

      // Resumes from cus_2
      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_2' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({ id: 'cus_3' })
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

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config,
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: {
            streams: { customers: { page_cursor: 'cus_3', status: 'pending' } },
            global: {},
          },
        })
      )

      expect(listFn).toHaveBeenCalledWith({ limit: 100, starting_after: 'cus_3' })

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(2)
      expect(records.map((r) => r.record.data.id)).toEqual(['cus_4', 'cus_5'])

      // Final state should be complete
      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states[states.length - 1].source_state.data).toMatchObject({
        page_cursor: null,
        status: 'complete',
      })
    })
  })

  describe('read(input) — enriched webhook processing', () => {
    it('delete event yields record with deleted: true', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'customers', data: { id: 'cus_1', object: 'customer', deleted: true } },
      })
      expect(messages[1]).toMatchObject({
        type: 'source_state',
        source_state: {
          stream: 'customers',
          data: { eventId: 'evt_del_1', eventCreated: 1700000000 },
        },
      })
    })

    it('delete event detected by event type (not just deleted flag)', async () => {
      const registry: Record<string, ResourceConfig> = {
        products: makeConfig({ order: 1, tableName: 'products' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'products', data: { id: 'prod_1', object: 'product', deleted: true } },
      })
    })

    it('subscription event yields subscription_items from nested items.data', async () => {
      const registry: Record<string, ResourceConfig> = {
        subscriptions: makeConfig({ order: 1, tableName: 'subscriptions' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'subscriptions', data: { id: 'sub_1' } },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        record: { stream: 'subscription_items', data: { id: 'si_1', price: 'price_1' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'record',
        record: { stream: 'subscription_items', data: { id: 'si_2', price: 'price_2' } },
      })
      expect(messages[3]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'subscriptions', data: { eventId: 'evt_sub_1' } },
      })
    })

    it('entitlement summary event yields individual entitlement records', async () => {
      const registry: Record<string, ResourceConfig> = {
        active_entitlements: makeConfig({ order: 1, tableName: 'active_entitlements' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: {
          stream: 'active_entitlements',
          data: {
            id: 'ent_1',
            feature: 'feat_premium',
            customer: 'cus_1',
            lookup_key: 'premium',
          },
        },
      })
      expect(messages[1]).toMatchObject({
        type: 'record',
        record: {
          stream: 'active_entitlements',
          data: {
            id: 'ent_2',
            feature: 'feat_basic',
            customer: 'cus_1',
            lookup_key: 'basic',
          },
        },
      })
      expect(messages[2]).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'active_entitlements', data: { eventId: 'evt_ent_1' } },
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
        subscriptions: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
      expect(records[0].record.data).toMatchObject({ id: 'sub_1', extra: 'revalidated' })
    })

    it('revalidation skips re-fetch when object is in final state', async () => {
      const retrieveFn = vi.fn()

      const registry: Record<string, ResourceConfig> = {
        subscriptions: makeConfig({
          order: 1,
          tableName: 'subscriptions',
          retrieveFn: retrieveFn as ResourceConfig['retrieveFn'],
          isFinalState: (s: { status: string }) => s.status === 'canceled',
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
      expect(records[0].record.data).toMatchObject({ id: 'sub_1', status: 'canceled' })
    })

    it('preview objects (no id) produce no output', async () => {
      const registry: Record<string, ResourceConfig> = {
        invoices: makeConfig({ order: 1, tableName: 'invoices' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
        record: { stream: 'checkout_sessions', data: { id: 'cs_1' } },
      })
    })

    it('throws when raw webhook input is provided without webhook_secret', async () => {
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers' }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
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
      customers: makeConfig({
        order: 1,
        tableName: 'customers',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
      invoices: makeConfig({
        order: 2,
        tableName: 'invoices',
        listFn: (() => Promise.resolve({ data: [], has_more: false })) as ResourceConfig['listFn'],
      }),
    }

    /** Push a synthetic event through the captured onEvent callback. */
    function pushWsEvent(event: StripeEvent) {
      capturedOnEvent!({
        type: 'webhook_event',
        webhook_id: 'wh_' + event.id,
        webhook_conversation_id: 'whc_1',
        event_payload: JSON.stringify(event),
        http_headers: {},
        endpoint: { url: 'stripe-sync-engine', status: 'enabled' },
      })
    }

    beforeEach(() => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
    })

    afterEach(() => {
      capturedOnEvent = null
      mockClose.mockClear()
    })

    it('read() creates WebSocket client when websocket: true', async () => {
      const { createStripeWebSocketClient } = await import('./src-websocket.js')

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
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
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      // Returning the iterator triggers the finally block, which calls wsClient.close()
      await iter.return()
      expect(mockClose).toHaveBeenCalled()
    })

    it('streams WebSocket events after empty backfill', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // Backfill: empty stream produces started + state(complete) + complete
      // capturedOnEvent is set during the first iter.next() (createStripeWebSocketClient is called inside read())
      const m1 = await iter.next() // stream_status started
      const m2 = await iter.next() // state complete
      const m3 = await iter.next() // stream_status complete
      expect(m1.value).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'started' } },
      })
      expect(m2.value).toMatchObject({
        type: 'source_state',
        source_state: { data: { status: 'complete' } },
      })
      expect(m3.value).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'complete' } },
      })

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
        record: { stream: 'customers', data: { id: 'cus_1', name: 'Alice via WS' } },
      })
      expect(m5.value).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { eventId: 'evt_ws_1' } },
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
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(wsRegistry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      // stream_status started — also triggers createStripeWebSocketClient, setting capturedOnEvent
      const m1 = await iter.next()
      expect(m1.value).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'started' } },
      })

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
        record: { stream: 'customers', data: { id: 'cus_ws_1', name: 'WS Queued' } },
      })
      expect(m3.value).toMatchObject({
        type: 'source_state',
        source_state: { stream: 'customers', data: { eventId: 'evt_ws_queued' } },
      })

      // Page 1: backfill record + state
      const m4 = await iter.next() // record cus_1
      const m5 = await iter.next() // state pending
      expect(m4.value).toMatchObject({ type: 'record', record: { data: { id: 'cus_1' } } })
      expect(m5.value).toMatchObject({
        type: 'source_state',
        source_state: { data: { status: 'pending' } },
      })

      // Before page 2: no queued events, so straight to backfill
      // Page 2: backfill record + state + stream_status complete
      const m6 = await iter.next() // record cus_2
      const m7 = await iter.next() // state complete
      const m8 = await iter.next() // stream_status complete
      expect(m6.value).toMatchObject({ type: 'record', record: { data: { id: 'cus_2' } } })
      expect(m7.value).toMatchObject({
        type: 'source_state',
        source_state: { data: { status: 'complete' } },
      })
      expect(m8.value).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'complete' } },
      })

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
        record: { stream: 'customers', data: { id: 'cus_live', name: 'Live Event' } },
      })
      expect(m10.value).toMatchObject({
        type: 'source_state',
        source_state: { data: { eventId: 'evt_ws_live' } },
      })

      await iter.return()
    })

    it('filters out WebSocket events for streams not in catalog', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() needed — WebSocket client is created inside read()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
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
        record: { stream: 'customers', data: { id: 'cus_1' } },
      })

      await iter.return()
    })

    it('read() with websocket: true creates WebSocket client (combined config)', async () => {
      const { createStripeWebSocketClient } = await import('./src-websocket.js')
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      vi.mocked(createStripeWebSocketClient).mockClear()

      const iter = source
        .read({
          config: {
            api_key: 'sk_test_fake',
            api_version: '2025-04-30.basil' as const,
            websocket: true,
          },
          catalog: catalog({ name: 'customers' }),
        })
        [Symbol.asyncIterator]()

      await iter.next() // stream_status started — triggers createStripeWebSocketClient

      expect(createStripeWebSocketClient).toHaveBeenCalledTimes(1)
      await iter.return()
    })

    it('teardown() is safe when no websocket was configured', async () => {
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      // No setup() call — teardown should not throw
      await drain(
        source.teardown!({
          config: { api_key: 'sk_test_fake', api_version: '2025-04-30.basil' as const },
        })
      )
      expect(mockClose).not.toHaveBeenCalled()
    })
  })

  describe('read() — HTTP server mode', () => {
    it('starts an HTTP server on webhook_port and processes POSTed webhooks', async () => {
      const listFn = vi.fn().mockResolvedValue({ data: [], has_more: false })
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({ order: 1, tableName: 'customers', listFn }),
      }
      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const cat = catalog({ name: 'customers' })

      // Use port 0 so the OS picks a free port
      const cfg = {
        api_key: 'sk_test_fake',
        api_version: '2025-04-30.basil' as const,
        webhook_secret: 'whsec_test',
        webhook_port: 0,
      }

      const messages: Message[] = []
      const iter = source.read({ config: cfg, catalog: cat, state: { streams: {}, global: {} } })

      // Drain backfill messages (started, state, complete for the empty stream)
      for (let i = 0; i < 3; i++) {
        const { value, done } = await iter.next()
        if (done) break
        messages.push(value)
      }

      expect(messages[0]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'started' } },
      })
      expect(messages[2]).toMatchObject({
        type: 'trace',
        trace: { trace_type: 'stream_status', stream_status: { status: 'complete' } },
      })

      // Clean up: return the iterator which triggers the finally block
      await iter.return(undefined as unknown as Message)
    })
  })

  describe('read() — events polling', () => {
    it('skips backfill when all streams are already complete', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: { customers: { page_cursor: null, status: 'complete' } }, global: {} },
        })
      )

      // listFn should NOT be called — stream is already complete
      expect(listFn).not.toHaveBeenCalled()

      // Should not emit trace(stream_status started) for complete streams
      const started = messages.filter(
        (m): m is TraceMessage =>
          m.type === 'trace' &&
          m.trace.trace_type === 'stream_status' &&
          (m.trace as { stream_status: { status: string } }).stream_status.status === 'started'
      )
      expect(started).toHaveLength(0)
    })

    it('stamps initial events_cursor after first backfill completes', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const now = Math.floor(Date.now() / 1000)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { streams: { customers: { page_cursor: null, status: 'complete' } }, global: {} },
        })
      )

      // Should emit a state message with events_cursor stamped
      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states).toHaveLength(1)
      expect(states[0].source_state.stream).toBe('customers')
      expect(
        (states[0].source_state.data as { events_cursor: number }).events_cursor
      ).toBeGreaterThanOrEqual(now)
      expect((states[0].source_state.data as { status: string }).status).toBe('complete')
    })

    it('does not run events polling when poll_events is false/absent', async () => {
      const listFn = vi.fn()
      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config, // no poll_events
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
          state: { customers: { page_cursor: null, status: 'complete' } },
        })
      )

      // No events_cursor should appear in output
      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      const withCursor = states.filter(
        (s) => (s.source_state.data as { events_cursor?: number }).events_cursor != null
      )
      expect(withCursor).toHaveLength(0)
    })

    it('does not poll when some streams are still pending', async () => {
      const custListFn = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'cus_1', name: 'Alice' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: custListFn as ResourceConfig['listFn'],
        }),
        invoices: makeConfig({
          order: 2,
          tableName: 'invoices',
          listFn: (() =>
            Promise.resolve({
              data: [{ id: 'inv_1' }],
              has_more: false,
            })) as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)
      const messages = await collect(
        source.read({
          config: { ...config, poll_events: true },
          catalog: catalog(
            { name: 'customers', primary_key: [['id']] },
            { name: 'invoices', primary_key: [['id']] }
          ),
          // customers is complete, but invoices is pending
          state: { streams: { customers: { page_cursor: null, status: 'complete' } }, global: {} },
        })
      )

      // Invoices should be backfilled (listFn called)
      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records.some((r) => r.record.stream === 'invoices')).toBe(true)

      // customers listFn should NOT be called (already complete)
      expect(custListFn).not.toHaveBeenCalled()

      // No events_cursor should appear — not all streams were complete at start
      // (invoices was pending, so pollEvents returns early)
      // But after backfill, invoices is now complete. However, pollEvents checks
      // the input state, not the post-backfill state, so it won't stamp cursors.
      const statesWithCursor = messages
        .filter((m): m is SourceStateMessage => m.type === 'source_state')
        .filter((s) => (s.source_state.data as { events_cursor?: number }).events_cursor != null)
      expect(statesWithCursor).toHaveLength(0)
    })
  })

  describe('read() — parallel backfill (segment checkpoint/resume)', () => {
    it('resumes only incomplete segments from prior segment state', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_resumed', name: 'Resumed' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const priorSegments: SegmentState[] = [
        { index: 0, gte: 1000000, lt: 1100000, page_cursor: null, status: 'complete' },
        { index: 1, gte: 1100000, lt: 1200000, page_cursor: 'cus_halfway', status: 'pending' },
        { index: 2, gte: 1200000, lt: 1300001, page_cursor: null, status: 'complete' },
      ]

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: {
            customers: { page_cursor: null, status: 'pending', segments: priorSegments },
          },
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith(
        expect.objectContaining({
          created: { gte: 1100000, lt: 1200000 },
          starting_after: 'cus_halfway',
          limit: 100,
        })
      )

      const records = messages.filter((m): m is RecordMessage => m.type === 'record')
      expect(records).toHaveLength(1)
      expect(records[0].record.data).toMatchObject({ id: 'cus_resumed' })

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      const lastState = states[states.length - 1]
      expect(lastState.source_state.data).toMatchObject({ status: 'complete' })
      const backfill = (lastState.source_state.data as StripeStreamState).backfill!
      expect(backfill.in_flight).toEqual([])
      expect(backfill.completed.length).toBeGreaterThan(0)
    })

    it('emits state with full segment snapshots after each page for resumability', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'item_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi
          .fn()
          .mockResolvedValue({ id: 'acct_test', object: 'account', created: 1000000 }),
      } as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'customers' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
        })
      )

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states.length).toBeGreaterThan(0)

      for (const state of states) {
        const data = state.source_state.data as StripeStreamState
        expect(data.backfill).toBeDefined()
        expect(data.backfill!.range).toBeDefined()
      }

      const lastData = states[states.length - 1].source_state.data as StripeStreamState
      expect(lastData.status).toBe('complete')
      // All work done — completed ranges should cover the full range
      expect(lastData.backfill!.in_flight).toEqual([])
    })
  })

  describe('read() — streams without supportsCreatedFilter sync sequentially', () => {
    it('uses sequential pagination (no created filter) for non-parallel streams', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'item_1', name: 'Sequential' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        tax_ids: makeConfig({
          order: 1,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'tax_ids' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith({ limit: 100 })

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      for (const state of states) {
        expect((state.source_state.data as StripeStreamState).segments).toBeUndefined()
      }
    })

    it('does not assume cursor pagination when the endpoint does not support it', async () => {
      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'report_type_1', name: 'One shot' }],
        has_more: true,
      })

      const registry: Record<string, ResourceConfig> = {
        reporting_report_types: makeConfig({
          order: 1,
          tableName: 'reporting_report_types',
          supportsCreatedFilter: false,
          supportsLimit: false,
          supportsForwardPagination: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {} as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: catalog({ name: 'reporting_report_types' }),
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
        })
      )

      expect(listFn).toHaveBeenCalledTimes(1)
      expect(listFn).toHaveBeenCalledWith({})

      const states = messages.filter((m): m is SourceStateMessage => m.type === 'source_state')
      expect(states.at(-1)?.source_state.data).toMatchObject({
        status: 'complete',
        page_cursor: null,
      })
    })

    it('parallel and sequential streams coexist in the same catalog', async () => {
      const parallelListFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_1' }],
        has_more: false,
      })
      const sequentialListFn = vi.fn().mockResolvedValue({
        data: [{ id: 'tax_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          supportsCreatedFilter: true,
          listFn: parallelListFn as ResourceConfig['listFn'],
        }),
        tax_ids: makeConfig({
          order: 2,
          tableName: 'tax_ids',
          supportsCreatedFilter: false,
          listFn: sequentialListFn as ResourceConfig['listFn'],
        }),
      }

      const mockClient = {
        getAccount: vi
          .fn()
          .mockResolvedValue({ id: 'acct_test', object: 'account', created: 1000000 }),
      } as unknown as StripeClient
      const rateLimiter: RateLimiter = async () => 0

      const messages = await collect(
        listApiBackfill({
          catalog: {
            streams: [{ stream: { name: 'customers' } }, { stream: { name: 'tax_ids' } }],
          },
          state: undefined,
          registry,
          client: mockClient,
          accountId: 'acct_test',
          rateLimiter,
        })
      )

      // First call is the density probe — verify it includes created filter
      expect(parallelListFn.mock.calls[0][0]).toEqual(
        expect.objectContaining({ limit: 100, created: expect.any(Object) })
      )

      for (const call of parallelListFn.mock.calls.slice(1)) {
        expect(call[0]).toHaveProperty('created')
      }

      for (const call of sequentialListFn.mock.calls) {
        expect(call[0]).not.toHaveProperty('created')
      }

      const statusMsgs = messages.filter(
        (m): m is TraceMessage => m.type === 'trace' && m.trace.trace_type === 'stream_status'
      )
      const completes = statusMsgs.filter(
        (m) =>
          (m.trace as { stream_status: { status: string } }).stream_status.status === 'complete'
      )
      expect(completes).toHaveLength(2)
    })
  })

  describe('rate limiting', () => {
    describe('createInMemoryRateLimiter', () => {
      it('returns 0 (no wait) when tokens are available', async () => {
        const limiter = createInMemoryRateLimiter(10)
        const wait = await limiter()
        expect(wait).toBe(0)
      })

      it('returns positive wait time when tokens are depleted', async () => {
        const limiter = createInMemoryRateLimiter(2)
        await limiter()
        await limiter()
        const wait = await limiter()
        expect(wait).toBeGreaterThan(0)
      })

      it('wait time scales inversely with RPS', async () => {
        const fastLimiter = createInMemoryRateLimiter(100)
        const slowLimiter = createInMemoryRateLimiter(1)

        for (let i = 0; i < 100; i++) await fastLimiter()
        const fastWait = await fastLimiter()

        await slowLimiter()
        const slowWait = await slowLimiter()

        expect(slowWait).toBeGreaterThan(fastWait)
      })
    })

    it('rate limiter is called before each list API page during backfill', async () => {
      const rateLimiterSpy = vi.fn().mockResolvedValue(0) as unknown as RateLimiter

      const listFn = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ id: 'item_1' }],
          has_more: true,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'item_2' }],
          has_more: false,
        })

      const registry: Record<string, ResourceConfig> = {
        items: makeConfig({
          order: 1,
          tableName: 'items',
          supportsCreatedFilter: false,
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      await collect(
        listApiBackfill({
          catalog: catalog({ name: 'items' }),
          state: undefined,
          registry,
          client: {} as unknown as StripeClient,
          accountId: 'acct_test',
          rateLimiter: rateLimiterSpy,
        })
      )

      expect(rateLimiterSpy).toHaveBeenCalledTimes(2)
    })

    it('createStripeSource uses external rate limiter when provided via deps', async () => {
      const externalLimiter = vi.fn().mockResolvedValue(0) as unknown as RateLimiter
      const customSource = createStripeSource({ rateLimiter: externalLimiter })

      const listFn = vi.fn().mockResolvedValue({
        data: [{ id: 'cus_1' }],
        has_more: false,
      })

      const registry: Record<string, ResourceConfig> = {
        customers: makeConfig({
          order: 1,
          tableName: 'customers',
          listFn: listFn as ResourceConfig['listFn'],
        }),
      }

      vi.mocked(buildResourceRegistry).mockReturnValue(registry as any)

      await collect(
        customSource.read({
          config: { api_key: 'sk_test_fake', api_version: '2025-04-30.basil' as const },
          catalog: catalog({ name: 'customers', primary_key: [['id']] }),
        })
      )

      expect(externalLimiter).toHaveBeenCalled()
    })
  })

  describe('architecture purity', () => {
    it('source never imports from or references any destination module', () => {
      const srcDir = path.resolve(import.meta.dirname, '..')
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
