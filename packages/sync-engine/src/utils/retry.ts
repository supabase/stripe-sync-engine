import Stripe from 'stripe'
import pino from 'pino'

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
 * Calculates exponential backoff delay with jitter
 * Formula: min(initialDelay * 2^attempt, maxDelay) + random(0, jitter)
 */
function calculateDelay(attempt: number, config: RetryConfig): number {
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
  logger?: pino.Logger
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

      // Calculate delay and wait before next attempt
      const delay = calculateDelay(attempt, retryConfig)

      logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
          maxRetries: retryConfig.maxRetries,
          delayMs: Math.round(delay),
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
