const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 32000
const MAX_RETRIES = 5

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

export type HttpRetryOptions = {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
}

export function getHttpErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined

  if ('status' in err && typeof err.status === 'number') {
    return err.status
  }

  if ('statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode
  }

  if ('code' in err && typeof err.code === 'number') {
    return err.code
  }

  return undefined
}

function getNestedErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined

  if ('code' in err && typeof err.code === 'string') {
    return err.code
  }

  if ('cause' in err) {
    return getNestedErrorCode(err.cause)
  }

  return undefined
}

export function isRetryableHttpError(err: unknown): boolean {
  const status = getHttpErrorStatus(err)
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true
  }
  if (status !== undefined) {
    return false
  }

  if (!(err instanceof Error)) {
    return false
  }

  // TimeoutError (from AbortSignal.timeout) is retryable — the request timed out.
  // AbortError (from AbortController.abort) is NOT — it means deliberate cancellation
  // (e.g. pipeline signal, client disconnect).
  if (err.name === 'TimeoutError') {
    return true
  }
  if (err.name === 'AbortError') {
    return false
  }

  const code = getNestedErrorCode(err)
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true
  }

  const message = err.message.toLowerCase()
  return (
    message.includes('fetch failed') || message.includes('network') || message.includes('timeout')
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(signal!.reason)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function withHttpRetry<T>(
  fn: () => Promise<T>,
  opts: HttpRetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  const maxDelayMs = opts.maxDelayMs ?? BACKOFF_MAX_MS
  let delayMs = opts.baseDelayMs ?? BACKOFF_BASE_MS

  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted()

    try {
      return await fn()
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableHttpError(err)) {
        throw err
      }

      const status = getHttpErrorStatus(err)
      const errName = err instanceof Error ? err.name : 'UnknownError'
      console.error(
        `[source-stripe] retry attempt=${attempt + 1}/${maxRetries} delay=${delayMs}ms status=${status ?? 'n/a'} error=${errName}`
      )

      await sleep(delayMs, opts.signal)
      delayMs = Math.min(delayMs * 2, maxDelayMs)
    }
  }
}
