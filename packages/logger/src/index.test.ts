import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  bindLogContext,
  createLogger,
  getEngineRequestId,
  runWithLogContext,
  withoutLogCapture,
  type RoutedLogEntry,
} from './index.js'

function devNull(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

describe('@stripe/sync-logger', () => {
  it('captures structured fields into routed log data', () => {
    const entries: RoutedLogEntry[] = []
    const logger = createLogger({
      name: 'logger-test',
      destination: devNull(),
    })

    runWithLogContext(
      {
        engineRequestId: 'req_123',
        onLog(entry) {
          entries.push(entry)
        },
      },
      () => {
        logger.info({ stream: 'customers', attempt: 2 }, 'connector logger message')
      }
    )

    expect(entries).toEqual([
      {
        level: 'info',
        message: 'connector logger message',
        data: {
          name: 'logger-test',
          engine_request_id: 'req_123',
          stream: 'customers',
          attempt: 2,
        },
      },
    ])
  })

  it('serializes errors into routed log data', () => {
    const entries: RoutedLogEntry[] = []
    const logger = createLogger({
      name: 'logger-test',
      destination: devNull(),
    })

    runWithLogContext(
      {
        onLog(entry) {
          entries.push(entry)
        },
      },
      () => {
        logger.error(new Error('boom'))
      }
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'error',
      message: 'boom',
      data: {
        name: 'logger-test',
        err: {
          name: 'Error',
          message: 'boom',
        },
      },
    })
  })

  it('suppresses routing inside withoutLogCapture', () => {
    const entries: RoutedLogEntry[] = []
    const logger = createLogger({
      name: 'logger-test',
      destination: devNull(),
    })

    runWithLogContext(
      {
        onLog(entry) {
          entries.push(entry)
        },
      },
      () => {
        withoutLogCapture(() => {
          logger.info('hidden')
        })
      }
    )

    expect(entries).toEqual([])
  })

  it('bindLogContext preserves context while iterating async streams', async () => {
    const entries: RoutedLogEntry[] = []
    const logger = createLogger({
      name: 'logger-test',
      destination: devNull(),
    })

    const iter = bindLogContext(
      (async function* () {
        await Promise.resolve()
        logger.info({ stream: 'customers' }, 'from stream')
        yield getEngineRequestId()
      })(),
      {
        engineRequestId: 'req_stream',
        onLog(entry) {
          entries.push(entry)
        },
      }
    )

    const values: Array<string | undefined> = []
    for await (const value of iter) values.push(value)

    expect(values).toEqual(['req_stream'])
    expect(entries).toEqual([
      {
        level: 'info',
        message: 'from stream',
        data: {
          name: 'logger-test',
          engine_request_id: 'req_stream',
          stream: 'customers',
        },
      },
    ])
  })
})
