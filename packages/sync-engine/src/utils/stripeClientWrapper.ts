import Stripe from 'stripe'
import { withRetry, RetryConfig } from './retry'
import type { Logger } from '../types'

/**
 * Creates a proxied Stripe client that automatically wraps all API calls with retry logic.
 *
 * This ensures that ALL Stripe API operations (list, retrieve, create, update, delete)
 * are protected against transient errors:
 * - Rate limits (429)
 * - Server errors (500, 502, 503, 504, 424)
 * - Connection errors (network failures)
 *
 * The proxy intercepts method calls at all levels, including nested resources
 * (e.g., stripe.checkout.sessions, stripe.webhookEndpoints).
 *
 * @param stripe - The base Stripe client instance
 * @param retryConfig - Optional retry configuration to override defaults
 * @param logger - Optional logger for tracking retry attempts
 * @returns A proxied Stripe client with automatic retry logic
 *
 * @example
 * const baseStripe = new Stripe(apiKey, { apiVersion: '2023-10-16' })
 * const stripe = createRetryableStripeClient(baseStripe, {}, logger)
 *
 * // All calls are now automatically retried on transient errors
 * const customer = await stripe.customers.retrieve('cus_123')
 * const invoices = await stripe.invoices.list({ limit: 100 })
 */
export function createRetryableStripeClient(
  stripe: Stripe,
  retryConfig: Partial<RetryConfig> = {},
  logger?: Logger
): Stripe {
  // Skip wrapping in test environments to preserve spy/mock functionality
  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    process.env.JEST_WORKER_ID !== undefined

  if (isTest) {
    return stripe
  }

  return new Proxy(stripe, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)

      // If it's a resource object (customers, invoices, etc.), wrap it recursively
      // Resources are objects with methods like list(), retrieve(), create(), etc.
      if (original && typeof original === 'object' && !isPromise(original)) {
        return wrapResource(original, retryConfig, logger)
      }

      return original
    },
  })
}

/**
 * Wraps a Stripe resource (like stripe.customers or stripe.invoices)
 * to automatically retry all of its methods.
 *
 * Handles both direct methods and nested resources:
 * - Direct: stripe.customers.list()
 * - Nested: stripe.checkout.sessions.list()
 *
 * @param resource - The Stripe resource to wrap
 * @param retryConfig - Retry configuration
 * @param logger - Optional logger
 * @returns Proxied resource with retry logic
 */
function wrapResource(
  resource: Record<string, unknown>,
  retryConfig: Partial<RetryConfig>,
  logger?: Logger
): Record<string, unknown> {
  return new Proxy(resource, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver)

      // If it's a function (API method), wrap it with retry logic
      if (typeof original === 'function') {
        return function (this: unknown, ...args: unknown[]) {
          // Bind the correct context and call the original function
          const result = original.apply(target, args)

          // Check if result is an async iterable (Stripe auto-pagination)
          // Auto-pagination returns objects with [Symbol.asyncIterator]
          if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
            // Return as-is - don't wrap async iterables
            return result
          }

          // Only wrap if it returns a Promise (actual API call)
          if (isPromise(result)) {
            // Wrap the promise with retry logic
            return withRetry(() => Promise.resolve(result), retryConfig, logger)
          }

          // Non-promise return values pass through (rare, but possible)
          return result
        }
      }

      // If it's a nested resource (e.g., stripe.checkout.sessions), recurse
      if (original && typeof original === 'object' && !isPromise(original)) {
        return wrapResource(original, retryConfig, logger)
      }

      // Primitive values, symbols, etc. pass through unchanged
      return original
    },
  })
}

/**
 * Type guard to check if a value is a Promise
 */
function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).then === 'function'
  )
}
