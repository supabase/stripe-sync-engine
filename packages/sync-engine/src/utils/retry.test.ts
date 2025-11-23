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

  it('should NOT retry on non-retryable errors (4xx client errors)', async () => {
    const badRequestError = new Stripe.errors.StripeInvalidRequestError({
      message: 'Invalid request',
    })
    const mockFn = vi.fn().mockRejectedValue(badRequestError)

    await expect(withRetry(mockFn)).rejects.toThrow(badRequestError)
    expect(mockFn).toHaveBeenCalledTimes(1) // No retries
  })

  it('should retry on server errors (5xx)', async () => {
    const serverError = new Stripe.errors.StripeAPIError({
      message: 'Internal server error',
    })
    // @ts-expect-error - setting statusCode for test
    serverError.statusCode = 500

    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce('success')

    const promise = withRetry(mockFn, { initialDelayMs: 1000, jitterMs: 0 })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFn).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2000)
    expect(mockFn).toHaveBeenCalledTimes(3)

    const result = await promise
    expect(result).toBe('success')
  })

  it('should retry on connection errors', async () => {
    const connectionError = new Stripe.errors.StripeConnectionError({
      message: 'Network error',
    })

    const mockFn = vi.fn().mockRejectedValueOnce(connectionError).mockResolvedValueOnce('success')

    const promise = withRetry(mockFn, { initialDelayMs: 1000, jitterMs: 0 })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockFn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(mockFn).toHaveBeenCalledTimes(2)

    const result = await promise
    expect(result).toBe('success')
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
        errorType: 'rate_limit',
        attempt: 1,
        maxRetries: 1,
        delayMs: 100,
        nextAttempt: 2,
      }),
      'Transient Stripe error, retrying after delay'
    )

    // Should log error when retries exhausted
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Rate limit exceeded',
        errorType: 'rate_limit',
        attempt: 2,
        maxRetries: 1,
      }),
      'Max retries exhausted for Stripe error'
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

    // Default: initialDelayMs = 1000, maxRetries = 5, jitterMs = 500
    // Advance through all retries: 1s, 2s, 4s, 8s, 16s (with max jitter)
    await vi.advanceTimersByTimeAsync(1500) // 1s + 500ms jitter
    await vi.advanceTimersByTimeAsync(2500) // 2s + 500ms jitter
    await vi.advanceTimersByTimeAsync(4500) // 4s + 500ms jitter
    await vi.advanceTimersByTimeAsync(8500) // 8s + 500ms jitter
    await vi.advanceTimersByTimeAsync(16500) // 16s + 500ms jitter

    await expect(promise).rejects.toThrow()
    expect(mockFn).toHaveBeenCalledTimes(6) // Initial + 5 retries
  })

  describe('Retry-After header handling', () => {
    it('should respect Retry-After header when provided', async () => {
      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '5' }, // Stripe says wait 5 seconds
      })

      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success')

      const promise = withRetry(mockFn, { jitterMs: 0 })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Should wait 5000ms as indicated by Retry-After header
      await vi.advanceTimersByTimeAsync(5000)
      expect(mockFn).toHaveBeenCalledTimes(2)

      const result = await promise
      expect(result).toBe('success')
    })

    it('should add jitter to Retry-After delay', async () => {
      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '5' },
      })

      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success')

      // Mock Math.random to return predictable value
      const originalRandom = Math.random
      Math.random = vi.fn().mockReturnValue(0.5)

      const promise = withRetry(mockFn, { jitterMs: 500 })

      await vi.advanceTimersByTimeAsync(0)

      // Expected delay: 5000 + (0.5 * 500) = 5250ms
      await vi.advanceTimersByTimeAsync(5250)
      expect(mockFn).toHaveBeenCalledTimes(2)

      Math.random = originalRandom
      await promise
    })

    it('should fall back to exponential backoff when Retry-After header is missing', async () => {
      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        // No headers property
      })

      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success')

      const promise = withRetry(mockFn, { initialDelayMs: 1000, jitterMs: 0 })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Should use exponential backoff: 1000ms
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockFn).toHaveBeenCalledTimes(2)

      await promise
    })

    it('should ignore invalid Retry-After values and use exponential backoff', async () => {
      const testCases = [
        { 'retry-after': 'invalid' }, // Non-numeric
        { 'retry-after': '-5' }, // Negative
        { 'retry-after': '0' }, // Zero
      ]

      for (const headers of testCases) {
        const rateLimitError = new Stripe.errors.StripeRateLimitError({
          message: 'Rate limit exceeded',
          headers,
        })

        const mockFn = vi
          .fn()
          .mockRejectedValueOnce(rateLimitError)
          .mockResolvedValueOnce('success')

        const promise = withRetry(mockFn, { initialDelayMs: 1000, jitterMs: 0 })

        await vi.advanceTimersByTimeAsync(0)

        // Should fall back to exponential backoff
        await vi.advanceTimersByTimeAsync(1000)
        expect(mockFn).toHaveBeenCalledTimes(2)

        await promise

        vi.clearAllMocks()
        vi.clearAllTimers()
      }
    })

    it('should respect long Retry-After values', async () => {
      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '120' }, // 2 minutes
      })

      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success')

      const promise = withRetry(mockFn, { jitterMs: 0 })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // Should wait the full 120 seconds
      await vi.advanceTimersByTimeAsync(120000)
      expect(mockFn).toHaveBeenCalledTimes(2)

      await promise
    })

    it('should log retryAfterMs when Retry-After header is present', async () => {
      const mockLogger = {
        warn: vi.fn(),
        error: vi.fn(),
      }

      const rateLimitError = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '5' },
      })

      const mockFn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce('success')

      const promise = withRetry(mockFn, { jitterMs: 0 }, mockLogger)

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(5000)

      await promise

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Rate limit exceeded',
          errorType: 'rate_limit',
          retryAfterMs: 5000,
          delayMs: 5000,
        }),
        'Transient Stripe error, retrying after delay'
      )
    })

    it('should handle multiple retries with different Retry-After values', async () => {
      const error1 = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '3' },
      })
      const error2 = new Stripe.errors.StripeRateLimitError({
        message: 'Rate limit exceeded',
        headers: { 'retry-after': '7' },
      })

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockResolvedValueOnce('success')

      const promise = withRetry(mockFn, { jitterMs: 0 })

      await vi.advanceTimersByTimeAsync(0)
      expect(mockFn).toHaveBeenCalledTimes(1)

      // First retry: wait 3 seconds
      await vi.advanceTimersByTimeAsync(3000)
      expect(mockFn).toHaveBeenCalledTimes(2)

      // Second retry: wait 7 seconds
      await vi.advanceTimersByTimeAsync(7000)
      expect(mockFn).toHaveBeenCalledTimes(3)

      const result = await promise
      expect(result).toBe('success')
    })
  })
})
