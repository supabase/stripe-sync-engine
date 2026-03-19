import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type {
  ErrorMessage,
  Message,
  RecordMessage,
  StateMessage,
  StreamStatusMessage,
} from '@stripe/sync-protocol'
import { StripeSource } from '../stripeSource'
import type { ResourceConfig } from '../types'

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

/** Collect all messages from an async iterator into an array. */
async function collect(iter: AsyncIterableIterator<Message>): Promise<Message[]> {
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

describe('StripeSource', () => {
  describe('discover()', () => {
    it('returns a CatalogMessage with known streams', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
        invoice: makeConfig({ order: 2, tableName: 'invoices' }),
      }

      const source = new StripeSource(registry)
      const catalog = await source.discover({})

      expect(catalog.type).toBe('catalog')
      expect(catalog.streams).toHaveLength(2)
      expect(catalog.streams.map((s) => s.name)).toEqual(['customers', 'invoices'])
    })

    it('excludes resources with sync: false', async () => {
      const registry: Record<string, ResourceConfig> = {
        customer: makeConfig({ order: 1, tableName: 'customers' }),
        internal: makeConfig({ order: 2, tableName: 'internal', sync: false }),
      }

      const source = new StripeSource(registry)
      const catalog = await source.discover({})

      expect(catalog.streams).toHaveLength(1)
      expect(catalog.streams[0].name).toBe('customers')
    })

    it('returns empty streams for empty registry', async () => {
      const source = new StripeSource({})
      const catalog = await source.discover({})

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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [{ name: 'customers', primary_key: [['id']] }])
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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [
          { name: 'customers', primary_key: [['id']] },
          { name: 'invoices', primary_key: [['id']] },
        ])
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

      const priorState: StateMessage[] = [
        {
          type: 'state',
          stream: 'customers',
          data: { pageCursor: 'cus_2', status: 'pending' },
        },
      ]

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [{ name: 'customers', primary_key: [['id']] }], priorState)
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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [{ name: 'customers', primary_key: [['id']] }])
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

    // Deferred: requires async event queue / push-based channel infrastructure
    // for the live-mode read() generator. This is a significant feature deferred
    // to a future phase (Inc 29 scope). (Inc 35)
    it.todo('transitions from backfill to live without stopping')
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

      const result = StripeSource.fromWebhookEvent(event, registry)

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

      const result = StripeSource.fromWebhookEvent(event, registry)
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

      const result = StripeSource.fromWebhookEvent(event, registry)
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

      const result = StripeSource.fromWebhookEvent(event, registry)

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

      const result = StripeSource.fromWebhookEvent(event, registry)
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

      const result = StripeSource.fromWebhookEvent(event, registry)

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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [{ name: 'customers', primary_key: [['id']] }])
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
      const source = new StripeSource({})
      const messages = await collect(
        source.read({}, [{ name: 'nonexistent', primary_key: [['id']] }])
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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [{ name: 'customers', primary_key: [['id']] }])
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

      const source = new StripeSource(registry)
      const messages = await collect(
        source.read({}, [
          { name: 'customers', primary_key: [['id']] },
          { name: 'invoices', primary_key: [['id']] },
        ])
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
