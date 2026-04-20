import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  delete process.env.PINO_PRETTY
  vi.restoreAllMocks()
})

describe('@stripe/sync-logger', () => {
  it('captures structured fields into routed log data', () => {
    const entries: RoutedLogEntry[] = []
    const log = createLogger({
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
        log.info({ stream: 'customers', attempt: 2 }, 'connector logger message')
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
    const log = createLogger({
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
        log.error(new Error('boom'))
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
    const log = createLogger({
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
          log.info('hidden')
        })
      }
    )

    expect(entries).toEqual([])
  })

  it('bindLogContext preserves context while iterating async streams', async () => {
    const entries: RoutedLogEntry[] = []
    const log = createLogger({
      name: 'logger-test',
      destination: devNull(),
    })

    const iter = bindLogContext(
      (async function* () {
        await Promise.resolve()
        log.info({ stream: 'customers' }, 'from stream')
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

  it('writes protocol log envelopes to stdout by default', () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const log = createLogger({ name: 'logger-test' })
    log.info({ stream: 'customers' }, 'protocol stdout')

    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toEqual({
      type: 'log',
      log: {
        level: 'info',
        message: 'protocol stdout',
        data: {
          name: 'logger-test',
          stream: 'customers',
        },
      },
    })
  })

  it('falls back to normal pino output when PINO_PRETTY=true', () => {
    process.env.PINO_PRETTY = 'true'

    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const log = createLogger({ name: 'logger-test' })
    log.info('pretty disabled protocol mode')

    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toMatchObject({
      level: 30,
      name: 'logger-test',
      msg: 'pretty disabled protocol mode',
    })
  })
})
