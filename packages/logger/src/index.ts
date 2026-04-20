import { AsyncLocalStorage } from 'node:async_hooks'
import { format, inspect } from 'node:util'
import pino from 'pino'
import type { DestinationStream, Logger, LoggerOptions } from 'pino'

export type { DestinationStream, Logger, LoggerOptions } from 'pino'

export type RoutedLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type RoutedLogEntry = {
  logger_name?: string
  level: RoutedLogLevel
  message: string
}

export type LoggerContext = {
  engineRequestId?: string
  onLog?: (entry: RoutedLogEntry) => void
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
): AsyncIterableIterator<T> {
  const base = storage.getStore() ?? {}
  const iterator = iterable[Symbol.asyncIterator]()
  const context = { ...base, ...patch }

  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(value?: unknown) {
      return storage.run(context, () => iterator.next(value as never)) as Promise<IteratorResult<T>>
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
  }
}

export function createAsyncQueue<T>(): {
  push(item: T): void
  close(): void
} & AsyncIterableIterator<T> {
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

  function next() {
    if (items.length > 0) {
      return Promise.resolve({ value: items.shift()!, done: false } as IteratorResult<T>)
    }
    if (closed) {
      return Promise.resolve({ value: undefined as T, done: true } as IteratorResult<T>)
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      waiters.push(resolve)
    })
  }

  return {
    push,
    close,
    [Symbol.asyncIterator]() {
      return this
    },
    next,
    return() {
      close()
      return Promise.resolve({ value: undefined as T, done: true } as IteratorResult<T>)
    },
    throw(error?: unknown) {
      close()
      return Promise.reject(error)
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

function formatCapturedMessage(args: unknown[]): string {
  if (args.length === 0) return ''
  if (typeof args[0] === 'string') return format(...(args as [string, ...unknown[]]))

  const [first, second, ...rest] = args
  if (typeof second === 'string') {
    const rendered = format(second, ...rest)
    const details = stringifyValue(first)
    return details === '{}' ? rendered : `${rendered} ${details}`
  }

  if (args.length === 1) return stringifyValue(first)
  return args.map(stringifyValue).join(' ')
}

function maybeRouteLog(loggerName: string | undefined, level: number, args: unknown[]) {
  const context = storage.getStore()
  if (!context?.onLog || context.suppressLogCapture) return
  const message = formatCapturedMessage(args)
  if (!message) return
  context.onLog({
    logger_name: loggerName,
    level: mapLevel(level),
    message,
  })
}

export function createLogger(
  options: LoggerOptions & {
    destination?: DestinationStream
  } = {}
): Logger {
  const { destination, hooks: userHooks, mixin: userMixin, ...pinoOptions } = options

  const loggerName = pinoOptions.name

  return pino(
    {
      ...pinoOptions,
      hooks: {
        ...userHooks,
        logMethod(inputArgs, method, level) {
          maybeRouteLog(loggerName, level, inputArgs)
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
