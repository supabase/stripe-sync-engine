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
 * Determines if an error is retryable (rate limits, server errors, or connection errors)
 *
 * Retryable errors include:
 * - StripeRateLimitError (429): Rate limiting - temporary throttling
 * - StripeAPIError (5xx): Server errors on Stripe's side (500, 502, 503, 504, 424)
 * - StripeConnectionError: Network connectivity issues
 *
 * Non-retryable errors (will fail immediately):
 * - StripeInvalidRequestError (400, 404): Invalid parameters
 * - StripeAuthenticationError (401): Invalid API key
 * - StripePermissionError (403): Insufficient permissions
 * - StripeCardError (402): Card declined
 * - StripeIdempotencyError (409): Idempotency key mismatch
 */
function isRetryableError(error: unknown): boolean {
  // Rate limiting (429)
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return true
  }

  // Server errors (5xx)
  if (error instanceof Stripe.errors.StripeAPIError) {
    const statusCode = error.statusCode
    // Retry on 500, 502, 503, 504, and 424 (external dependency failed)
    if (statusCode && [500, 502, 503, 504, 424].includes(statusCode)) {
      return true
    }
  }

  // Connection errors (network issues)
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return true
  }

  return false
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
 * Gets a human-readable description of the error type for logging
 */
function getErrorType(error: unknown): string {
  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return 'rate_limit'
  }
  if (error instanceof Stripe.errors.StripeAPIError) {
    return `api_error_${error.statusCode}`
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return 'connection_error'
  }
  return 'unknown'
}

/**
 * Executes a function with exponential backoff retry on transient Stripe errors
 *
 * Retries on:
 * - Rate limit errors (429) - respects Retry-After header
 * - Server errors (500, 502, 503, 504, 424)
 * - Connection errors (network failures)
 *
 * Fails immediately on:
 * - Client errors (400, 401, 403, 404) - invalid requests
 * - Authentication/permission errors
 * - Card errors
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration (optional)
 * @param logger - Logger for tracking retry attempts (optional)
 * @returns Promise that resolves to the function result
 * @throws The last error if all retries are exhausted, or immediately for non-retryable errors
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

      // Only retry transient errors (rate limits, server errors, connection errors)
      if (!isRetryableError(error)) {
        throw error
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= retryConfig.maxRetries) {
        logger?.error(
          {
            error: error instanceof Error ? error.message : String(error),
            errorType: getErrorType(error),
            attempt: attempt + 1,
            maxRetries: retryConfig.maxRetries,
          },
          'Max retries exhausted for Stripe error'
        )
        throw error
      }

      // Extract Retry-After header if present (only for rate limit errors)
      const retryAfterMs = getRetryAfterMs(error)

      // Calculate delay and wait before next attempt
      const delay = calculateDelay(attempt, retryConfig, retryAfterMs)

      logger?.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          errorType: getErrorType(error),
          attempt: attempt + 1,
          maxRetries: retryConfig.maxRetries,
          delayMs: Math.round(delay),
          retryAfterMs: retryAfterMs ?? undefined,
          nextAttempt: attempt + 2,
        },
        'Transient Stripe error, retrying after delay'
      )

      await sleep(delay)
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError
}
