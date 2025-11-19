import Stripe from 'stripe'
import type { Logger } from '../types'

export interface RetryConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  jitterMs: number
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  initialDelayMs: 1000, // 1 second
  maxDelayMs: 60000, // 60 seconds
  jitterMs: 500, // randomization to prevent thundering herd
}

/**
 * Determines if an error is a 429 rate limit error
 */
function isRateLimitError(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeRateLimitError
}

/**
 * Extracts the Retry-After header value from a Stripe rate limit error
 * Returns the value in milliseconds, or null if not present/invalid
 *
 * @param error - The error to extract from
 * @returns Retry-After delay in milliseconds, or null
 */
function getRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof Stripe.errors.StripeRateLimitError)) {
    return null
  }

  const retryAfterHeader = error.headers?.['retry-after']
  if (!retryAfterHeader) {
    return null
  }

  const retryAfterSeconds = Number(retryAfterHeader)

  // Validate: must be a positive number
  if (isNaN(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return null
  }

  return retryAfterSeconds * 1000 // Convert to milliseconds
}

/**
 * Calculates retry delay, preferring Retry-After header if available
 * Falls back to exponential backoff with jitter if Retry-After not present
 *
 * When Retry-After is present: use it (trusting Stripe's guidance)
 * When not present: use exponential backoff with jitter
 *
 * @param attempt - Current retry attempt number (0-indexed)
 * @param config - Retry configuration
 * @param retryAfterMs - Optional Retry-After value from Stripe (in milliseconds)
 * @returns Delay in milliseconds before next retry
 */
function calculateDelay(
  attempt: number,
  config: RetryConfig,
  retryAfterMs?: number | null
): number {
  // If Stripe provided Retry-After header, trust it
  if (retryAfterMs !== null && retryAfterMs !== undefined) {
    // Still add jitter to prevent thundering herd
    const jitter = Math.random() * config.jitterMs
    return retryAfterMs + jitter
  }

  // Fall back to exponential backoff
  // Exponential: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped at maxDelay)
  const exponentialDelay = Math.min(config.initialDelayMs * Math.pow(2, attempt), config.maxDelayMs)

  // Add random jitter to prevent thundering herd problem
  const jitter = Math.random() * config.jitterMs

  return exponentialDelay + jitter
}

/**
 * Sleeps for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Executes a function with exponential backoff retry on 429 rate limit errors
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration (optional)
 * @param logger - Logger for tracking retry attempts (optional)
 * @returns Promise that resolves to the function result
 * @throws The last error if all retries are exhausted, or immediately for non-429 errors
 *
 * @example
 * const customer = await withRetry(
 *   () => stripe.customers.retrieve('cus_123'),
 *   { maxRetries: 3 },
 *   logger
 * )
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  logger?: Logger
): Promise<T> {
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config }
  let lastError: unknown

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Only retry rate limit errors (429)
      if (!isRateLimitError(error)) {
        throw error
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= retryConfig.maxRetries) {
        logger?.error(
          {
            error: error instanceof Error ? error.message : String(error),
            attempt: attempt + 1,
            maxRetries: retryConfig.maxRetries,
          },
          'Max retries exhausted for rate limit error'
        )
        throw error
      }

      // Extract Retry-After header if present
      const retryAfterMs = getRetryAfterMs(error)

      // Calculate delay and wait before next attempt
      const delay = calculateDelay(attempt, retryConfig, retryAfterMs)

      logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          maxRetries: retryConfig.maxRetries,
          delayMs: Math.round(delay),
          retryAfterMs: retryAfterMs ?? undefined,
          nextAttempt: attempt + 2,
        },
        'Rate limit hit, retrying Stripe API call after delay'
      )

      await sleep(delay)
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError
}
