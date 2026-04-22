import { describe, it, expect } from 'vitest'
import { createLogger } from '@stripe/sync-logger'
import { logApiStream } from './helpers.js'

/**
 * Collect all messages from an async iterable into an array.
 */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe('logApiStream: log ordering', () => {
  it('logs produced during an item appear BEFORE that item in the output', async () => {
    const logger = createLogger({ name: 'test-ordering', level: 'debug' })

    // A generator that logs before each yield.  The log calls go through pino's
    // logMethod hook → AsyncLocalStorage onLog → pending[], and must be flushed
    // before the item they accompany.
    async function* source() {
      logger.info('log-for-item-1')
      yield { type: 'record', id: 1 }

      logger.info('log-for-item-2')
      yield { type: 'record', id: 2 }

      logger.info('log-for-item-3')
      yield { type: 'record', id: 3 }
    }

    const output = await collect(logApiStream('test', source(), {}))

    // Extract a simplified sequence for assertion
    const sequence = output
      .map((msg) => {
        const m = msg as { type: string; log?: { message: string }; id?: number }
        if (m.type === 'log' && m.log?.message?.startsWith('log-for-item-')) return m.log.message
        if (m.type === 'record') return `item-${m.id}`
        return null
      })
      .filter(Boolean)

    // Each "log-for-item-N" must come immediately before "item-N"
    expect(sequence).toEqual([
      'log-for-item-1',
      'item-1',
      'log-for-item-2',
      'item-2',
      'log-for-item-3',
      'item-3',
    ])
  })

  it('multiple logs for a single item all appear before that item', async () => {
    const logger = createLogger({ name: 'test-multi-log', level: 'debug' })

    async function* source() {
      logger.info('setup-query')
      logger.info('query-executed')
      logger.error('row-warning')
      yield { type: 'record', id: 1 }
    }

    const output = await collect(logApiStream('test', source(), {}))

    const sequence = output
      .map((msg) => {
        const m = msg as { type: string; log?: { message: string }; id?: number }
        if (m.type === 'log') return `log:${m.log?.message}`
        if (m.type === 'record') return `item-${m.id}`
        return null
      })
      .filter(Boolean)

    expect(sequence).toEqual(['log:setup-query', 'log:query-executed', 'log:row-warning', 'item-1'])
  })

  it('error logs from a throw appear before the protocol error messages', async () => {
    const logger = createLogger({ name: 'test-error-ordering', level: 'debug' })

    async function* source() {
      logger.info('starting')
      yield { type: 'record', id: 1 }
      logger.error('about-to-fail')
      throw new Error('kaboom')
    }

    const output = await collect(logApiStream('test', source(), {}))

    const types = output.map((msg) => {
      const m = msg as { type: string; log?: { level: string; message: string } }
      if (m.type === 'log') return `log:${m.log?.message}`
      if (m.type === 'connection_status') return 'connection_status'
      if (m.type === 'record') return 'record'
      return m.type
    })

    // 'about-to-fail' must come before the engine's error messages
    const failIdx = types.indexOf('log:about-to-fail')
    const connIdx = types.indexOf('connection_status')
    expect(failIdx).toBeGreaterThan(-1)
    expect(connIdx).toBeGreaterThan(-1)
    expect(failIdx).toBeLessThan(connIdx)
  })

  it('no logs appear after the final item when the stream completes normally', async () => {
    const logger = createLogger({ name: 'test-no-trailing', level: 'debug' })

    async function* source() {
      logger.info('processing')
      yield { type: 'record', id: 1 }
      // No log after the last yield — nothing should trail
    }

    const output = await collect(logApiStream('test', source(), {}))

    // Find the last 'record' index
    const lastRecordIdx = output.findLastIndex((m) => (m as { type: string }).type === 'record')

    // Everything after the last record should only be engine summary logs
    // (from log.debug(`${label} completed`)), not connector logs
    const trailing = output.slice(lastRecordIdx + 1)
    for (const msg of trailing) {
      const m = msg as { type: string; log?: { message: string } }
      if (m.type === 'log') {
        // Only the engine's own summary log should appear here
        expect(m.log?.message).not.toBe('processing')
      }
    }
  })
})
