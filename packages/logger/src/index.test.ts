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
        action_id: 'act_123',
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
          action_id: 'act_123',
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
        action_id: 'act_stream',
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
          action_id: 'act_stream',
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
    const parsed = JSON.parse(writes[0]!)
    expect(parsed).toMatchObject({
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
    expect(parsed._ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('suppresses default stdout protocol logs inside async-local context', () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const log = createLogger({ name: 'logger-test' })

    runWithLogContext({ suppressProtocolStdout: true }, () => {
      log.info({ stream: 'customers' }, 'quiet log')
    })

    expect(writes).toHaveLength(0)
  })

  it('mirrors protocol log envelopes to async-local destinations', () => {
    const writes: string[] = []
    const log = createLogger({ name: 'logger-test', destination: devNull() })

    runWithLogContext(
      {
        protocolLogDestinations: [
          {
            write(chunk: string) {
              writes.push(chunk)
              return true
            },
          } as unknown as Writable,
        ],
      },
      () => {
        log.info({ stream: 'customers' }, 'mirrored log')
      }
    )

    expect(writes).toHaveLength(1)
    const parsed = JSON.parse(writes[0]!)
    expect(parsed).toMatchObject({
      type: 'log',
      log: {
        level: 'info',
        message: 'mirrored log',
        data: {
          name: 'logger-test',
          stream: 'customers',
        },
      },
    })
    expect(parsed._ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('applies default redaction in structured stdout logs', () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const log = createLogger({ name: 'logger-test' })
    log.info({ api_key: 'sk_test_123', nested: { password: 'secret' } }, 'secret fields')

    expect(writes).toHaveLength(1)
    const parsed = JSON.parse(writes[0]!)
    expect(parsed).toMatchObject({
      type: 'log',
      log: {
        level: 'info',
        message: 'secret fields',
        data: {
          name: 'logger-test',
          api_key: '[redacted]',
          nested: {
            password: '[redacted]',
          },
        },
      },
    })
    expect(parsed._ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
