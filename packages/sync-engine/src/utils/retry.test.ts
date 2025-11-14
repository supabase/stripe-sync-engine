import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Stripe from 'stripe'
import { withRetry } from './retry'

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('should succeed on first attempt without retrying', async () => {
    const mockFn = vi.fn().mockResolvedValue('success')

    const result = await withRetry(mockFn)

    expect(result).toBe('success')
    expect(mockFn).toHaveBeenCalledTimes(1)
  })

  it('should retry on 429 rate limit error and eventually succeed', async () => {
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(
        new Stripe.errors.StripeRateLimitError({ message: 'Rate limit exceeded' })
      )
      .mockRejectedValueOnce(
        new Stripe.errors.StripeRateLimitError({ message: 'Rate limit exceeded' })
      )
      .mockResolvedValueOnce('success')

    const promise = withRetry(mockFn, { initialDelayMs: 1000, jitterMs: 0 })

    // First call fails
    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    // Wait for first retry delay (1s)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFn).toHaveBeenCalledTimes(2)

    // Wait for second retry delay (2s)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFn).toHaveBeenCalledTimes(3)

    const result = await promise
    expect(result).toBe('success')
  })

  it('should throw after exhausting max retries', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    const promise = withRetry(mockFn, { maxRetries: 2, initialDelayMs: 100, jitterMs: 0 })

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(0) // First call
    await vi.advanceTimersByTimeAsync(100) // First retry (100ms)
    await vi.advanceTimersByTimeAsync(200) // Second retry (200ms)

    await expect(promise).rejects.toThrow(rateLimitError)
    expect(mockFn).toHaveBeenCalledTimes(3) // Initial + 2 retries
  })

  it('should NOT retry on non-429 errors', async () => {
    const badRequestError = new Stripe.errors.StripeInvalidRequestError({
      message: 'Invalid request',
    })
    const mockFn = vi.fn().mockRejectedValue(badRequestError)

    await expect(withRetry(mockFn)).rejects.toThrow(badRequestError)
    expect(mockFn).toHaveBeenCalledTimes(1) // No retries
  })

  it('should use exponential backoff timing', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    const promise = withRetry(mockFn, {
      maxRetries: 4,
      initialDelayMs: 1000,
      jitterMs: 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    // Retry 1: 1s delay (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFn).toHaveBeenCalledTimes(2)

    // Retry 2: 2s delay (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFn).toHaveBeenCalledTimes(3)

    // Retry 3: 4s delay (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(mockFn).toHaveBeenCalledTimes(4)

    // Retry 4: 8s delay (1000 * 2^3)
    await vi.advanceTimersByTimeAsync(8000)
    expect(mockFn).toHaveBeenCalledTimes(5)

    await expect(promise).rejects.toThrow(rateLimitError)
  })

  it('should respect maxDelayMs cap', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    const promise = withRetry(mockFn, {
      maxRetries: 3,
      initialDelayMs: 10000,
      maxDelayMs: 15000, // Cap at 15s
      jitterMs: 0,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    // Retry 1: 10s delay (10000 * 2^0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(mockFn).toHaveBeenCalledTimes(2)

    // Retry 2: Would be 20s (10000 * 2^1), capped at 15s
    await vi.advanceTimersByTimeAsync(15000)
    expect(mockFn).toHaveBeenCalledTimes(3)

    // Retry 3: Would be 40s (10000 * 2^2), capped at 15s
    await vi.advanceTimersByTimeAsync(15000)
    expect(mockFn).toHaveBeenCalledTimes(4)

    await expect(promise).rejects.toThrow(rateLimitError)
  })

  it('should log retry attempts when logger is provided', async () => {
    const mockLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    }
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    const promise = withRetry(
      mockFn,
      { maxRetries: 1, initialDelayMs: 100, jitterMs: 0 },
      mockLogger
    )

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).rejects.toThrow()

    // Should log warning for retry attempt
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        attempt: 1,
        maxRetries: 1,
        delayMs: 100,
        nextAttempt: 2,
      }),
      'Rate limit hit, retrying Stripe API call after delay'
    )

    // Should log error when retries exhausted
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        attempt: 2,
        maxRetries: 1,
      }),
      'Max retries exhausted for rate limit error'
    )
  })

  it('should add jitter to delay', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    // Mock Math.random to return predictable value
    const originalRandom = Math.random
    Math.random = vi.fn().mockReturnValue(0.5)

    const promise = withRetry(mockFn, {
      maxRetries: 1,
      initialDelayMs: 1000,
      jitterMs: 500,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    // Expected delay: 1000 + (0.5 * 500) = 1250ms
    await vi.advanceTimersByTimeAsync(1250)
    expect(mockFn).toHaveBeenCalledTimes(2)

    Math.random = originalRandom
    await expect(promise).rejects.toThrow()
  })

  it('should handle async function that throws synchronously', async () => {
    const syncError = new Error('Sync error')
    const mockFn = vi.fn(() => {
      throw syncError
    })

    await expect(withRetry(mockFn)).rejects.toThrow(syncError)
    expect(mockFn).toHaveBeenCalledTimes(1)
  })

  it('should use default config values when not specified', async () => {
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })
    const mockFn = vi.fn().mockRejectedValue(rateLimitError)

    const promise = withRetry(mockFn) // No config provided

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    // Default: initialDelayMs = 1000, with up to 500ms jitter
    // Advance by max possible delay for first retry
    await vi.advanceTimersByTimeAsync(1500)
    expect(mockFn).toHaveBeenCalledTimes(2)

    // We won't test all 5 retries, just verify defaults work
    await expect(promise).rejects.toThrow()
  })
})
