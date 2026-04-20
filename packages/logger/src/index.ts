import { AsyncLocalStorage } from 'node:async_hooks'
import { format, inspect } from 'node:util'
import pino from 'pino'
import type { DestinationStream, Logger, LoggerOptions } from 'pino'

export type { DestinationStream, Logger, LoggerOptions } from 'pino'
export const destination = pino.destination

export type RoutedLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type RoutedLogEntry = {
  level: RoutedLogLevel
  message: string
  data?: Record<string, unknown>
}

const DEFAULT_REDACT_PATHS = ['*.api_key', '*.connection_string', '*.password', '*.url']
const DEFAULT_REDACT_CENSOR = '[redacted]'

export type LoggerContext = {
  engineRequestId?: string
  onLog?: (entry: RoutedLogEntry) => void
  protocolLogDestinations?: DestinationStream[]
  suppressLogCapture?: boolean
}

const storage = new AsyncLocalStorage<LoggerContext>()

export function getLoggerContext(): Readonly<LoggerContext> | undefined {
  return storage.getStore()
}

export function getEngineRequestId(): string | undefined {
  return storage.getStore()?.engineRequestId
}

export function runWithLogContext<T>(patch: Partial<LoggerContext>, fn: () => T): T {
  const current = storage.getStore() ?? {}
  return storage.run({ ...current, ...patch }, fn)
}

export function withoutLogCapture<T>(fn: () => T): T {
  return runWithLogContext({ suppressLogCapture: true }, fn)
}

export function bindLogContext<T>(
  iterable: AsyncIterable<T>,
  patch: Partial<LoggerContext>
): AsyncIterable<T> {
  const base = storage.getStore() ?? {}

  return {
    [Symbol.asyncIterator]() {
      const iterator = iterable[Symbol.asyncIterator]()
      const context = { ...base, ...patch }

      return {
        next(value?: unknown) {
          return storage.run(context, () => iterator.next(value as never)) as Promise<
            IteratorResult<T>
          >
        },
        return(value?: unknown) {
          if (!iterator.return) {
            return Promise.resolve({ value: value as T, done: true })
          }
          return storage.run(context, () => iterator.return!(value as never)) as Promise<
            IteratorResult<T>
          >
        },
        throw(error?: unknown) {
          if (!iterator.throw) return Promise.reject(error)
          return storage.run(context, () => iterator.throw!(error)) as Promise<IteratorResult<T>>
        },
      } satisfies AsyncIterator<T>
    },
  }
}

export function createAsyncQueue<T>(): {
  push(item: T): void
  close(): void
  [Symbol.asyncIterator](): AsyncIterator<T>
} {
  const items: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false

  function push(item: T) {
    if (closed) return
    const waiter = waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else items.push(item)
  }

  function close() {
    if (closed) return
    closed = true
    while (waiters.length > 0) {
      waiters.shift()!({ value: undefined as T, done: true })
    }
  }

  return {
    push,
    close,
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) {
            return Promise.resolve({ value: items.shift()!, done: false })
          }
          if (closed) {
            return Promise.resolve({ value: undefined as T, done: true })
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve)
          })
        },
        return() {
          close()
          return Promise.resolve({ value: undefined as T, done: true })
        },
      } satisfies AsyncIterator<T>
    },
  }
}

function mapLevel(level: number): RoutedLogLevel {
  if (level >= 50) return 'error'
  if (level >= 40) return 'warn'
  if (level >= 30) return 'info'
  return 'debug'
}

function stringifyValue(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return inspect(value, { depth: 4, breakLength: Infinity })
  }
}

function serializeError(value: Error): Record<string, unknown> {
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type RedactConfig = Exclude<LoggerOptions['redact'], string[] | undefined>

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function cloneForRedaction<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneForRedaction(item)) as T
  }
  if (isObjectLike(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneForRedaction(nested)])
    ) as T
  }
  return value
}

function applyRedactionPath(
  value: unknown,
  segments: string[],
  censor: unknown,
  remove: boolean,
  index = 0
): void {
  if (!isObjectLike(value)) return

  const segment = segments[index]
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value)

  if (segment === '*') {
    for (const [key, nested] of entries) {
      if (index === segments.length - 1) {
        if (remove) {
          if (Array.isArray(value)) {
            ;(value as unknown[])[Number(key)] = undefined
          } else {
            delete (value as Record<string, unknown>)[String(key)]
          }
        } else if (Array.isArray(value)) {
          ;(value as unknown[])[Number(key)] = censor
        } else {
          ;(value as Record<string, unknown>)[String(key)] = censor
        }
      } else {
        applyRedactionPath(nested, segments, censor, remove, index + 1)
      }
    }
    return
  }

  if (!(segment in value)) return

  if (index === segments.length - 1) {
    if (remove) {
      delete (value as Record<string, unknown>)[segment]
    } else {
      ;(value as Record<string, unknown>)[segment] = censor
    }
    return
  }

  applyRedactionPath((value as Record<string, unknown>)[segment], segments, censor, remove, index + 1)
}

function redactData(
  data: Record<string, unknown> | undefined,
  redact: LoggerOptions['redact']
): Record<string, unknown> | undefined {
  if (!data || !redact) return data

  const config = Array.isArray(redact)
    ? { paths: redact, censor: DEFAULT_REDACT_CENSOR, remove: false }
    : redact

  const cloned = cloneForRedaction(data)
  for (const path of config.paths ?? []) {
    applyRedactionPath(cloned, path.split('.'), config.censor ?? DEFAULT_REDACT_CENSOR, config.remove ?? false)
    if (path.startsWith('*.')) {
      applyRedactionPath(
        cloned,
        path.slice(2).split('.'),
        config.censor ?? DEFAULT_REDACT_CENSOR,
        config.remove ?? false
      )
    }
  }
  return cloned
}

function extractCapturedData(
  loggerName: string | undefined,
  args: unknown[],
  redact?: LoggerOptions['redact']
): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {}

  if (loggerName) data.name = loggerName

  const engineRequestId = getEngineRequestId()
  if (engineRequestId) data.engine_request_id = engineRequestId

  const first = args[0]
  if (first instanceof Error) {
    data.err = serializeError(first)
  } else if (isRecord(first)) {
    Object.assign(data, first)
  }

  return redactData(Object.keys(data).length > 0 ? data : undefined, redact)
}

function formatCapturedMessage(args: unknown[]): string {
  if (args.length === 0) return ''
  if (typeof args[0] === 'string') return format(...(args as [string, ...unknown[]]))

  const [first, second, ...rest] = args
  if (typeof second === 'string') return format(second, ...rest)

  if (first instanceof Error) return first.message
  if (isRecord(first)) return ''
  if (args.length === 1) return stringifyValue(first)
  return args.map(stringifyValue).join(' ')
}

function maybeRouteLog(
  loggerName: string | undefined,
  level: number,
  args: unknown[],
  redact?: LoggerOptions['redact']
) {
  const context = storage.getStore()
  if (!context?.onLog || context.suppressLogCapture) return
  const message = formatCapturedMessage(args)
  context.onLog({
    level: mapLevel(level),
    message,
    data: extractCapturedData(loggerName, args, redact),
  })
}

function isProtocolStdoutMode(options: {
  destination?: DestinationStream
  transport?: LoggerOptions['transport']
}): boolean {
  return !options.destination && !options.transport
}

function writeProtocolStdout(
  loggerName: string | undefined,
  level: number,
  args: unknown[],
  redact?: LoggerOptions['redact']
) {
  const data = extractCapturedData(loggerName, args, redact)
  writeProtocolLogPayload(process.stdout, createProtocolLogPayload(level, formatCapturedMessage(args), data))
}

function createProtocolLogPayload(
  level: number,
  message: string,
  data?: Record<string, unknown>
) {
  return {
    type: 'log',
    log: {
      level: mapLevel(level),
      message,
      ...(data ? { data } : {}),
    },
  }
}

function writeProtocolLogPayload(destination: Pick<DestinationStream, 'write'>, payload: unknown) {
  destination.write(JSON.stringify(payload) + '\n')
}

function writeContextProtocolLogs(
  loggerName: string | undefined,
  level: number,
  args: unknown[],
  redact?: LoggerOptions['redact']
) {
  const destinations = storage.getStore()?.protocolLogDestinations
  if (!destinations?.length) return

  const data = extractCapturedData(loggerName, args, redact)
  const payload = createProtocolLogPayload(level, formatCapturedMessage(args), data)
  for (const destination of destinations) writeProtocolLogPayload(destination, payload)
}

function mergeRedact(redact: LoggerOptions['redact']): RedactConfig {
  if (!redact) {
    return {
      paths: DEFAULT_REDACT_PATHS,
      censor: DEFAULT_REDACT_CENSOR,
    }
  }

  if (Array.isArray(redact)) {
    return {
      paths: [...DEFAULT_REDACT_PATHS, ...redact],
      censor: DEFAULT_REDACT_CENSOR,
    }
  }

  return {
    ...redact,
    paths: [...DEFAULT_REDACT_PATHS, ...(redact.paths ?? [])],
    censor: redact.censor ?? DEFAULT_REDACT_CENSOR,
  }
}

export function createLogger(
  options: LoggerOptions & {
    destination?: DestinationStream
  } = {}
): Logger {
  const { destination, hooks: userHooks, mixin: userMixin, ...pinoOptions } = options

  const loggerName = pinoOptions.name
  const protocolStdoutMode = isProtocolStdoutMode({ destination, transport: pinoOptions.transport })
  const redact = mergeRedact(pinoOptions.redact)

  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      ...pinoOptions,
      redact,
      hooks: {
        ...userHooks,
        logMethod(inputArgs, method, level) {
          maybeRouteLog(loggerName, level, inputArgs, redact)
          writeContextProtocolLogs(loggerName, level, inputArgs, redact)
          if (protocolStdoutMode) {
            writeProtocolStdout(loggerName, level, inputArgs, redact)
            return
          }
          if (userHooks?.logMethod) {
            return userHooks.logMethod.call(this, inputArgs, method, level)
          }
          return method.apply(this, inputArgs)
        },
      },
      mixin(...args) {
        const base = userMixin ? userMixin.apply(this, args) : {}
        const engineRequestId = getEngineRequestId()
        return engineRequestId ? { ...base, engine_request_id: engineRequestId } : base
      },
    },
    destination
  )
}
