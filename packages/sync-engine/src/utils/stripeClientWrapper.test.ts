import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { createRetryableStripeClient } from './stripeClientWrapper'
import { withRetry } from './retry'

// Mock the retry module - must return a Promise since withRetry is async
vi.mock('./retry', () => ({
  withRetry: vi.fn(async (fn) => fn()),
}))

describe('createRetryableStripeClient', () => {
  let mockStripe: Stripe
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockLogger: any

  beforeEach(() => {
    vi.clearAllMocks()

    // Create a mock Stripe instance with common resources
    mockStripe = {
      customers: {
        retrieve: vi.fn().mockResolvedValue({ id: 'cus_123' }),
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
      },
      invoices: {
        retrieve: vi.fn().mockResolvedValue({ id: 'in_123' }),
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      // Nested resource
      checkout: {
        sessions: {
          retrieve: vi.fn().mockResolvedValue({ id: 'cs_123' }),
          list: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
      webhookEndpoints: {
        retrieve: vi.fn().mockResolvedValue({ id: 'we_123' }),
        create: vi.fn().mockResolvedValue({ id: 'we_new' }),
        del: vi.fn().mockResolvedValue({ deleted: true }),
      },
      // Non-API property (should pass through)
      webhooks: {
        constructEvent: vi.fn(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
  })

  describe('Direct resource methods', () => {
    it('should wrap customers.retrieve with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.customers.retrieve('cus_123')

      expect(result).toEqual({ id: 'cus_123' })
      expect(mockStripe.customers.retrieve).toHaveBeenCalledWith('cus_123')
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap customers.list with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.customers.list({ limit: 10 })

      expect(result).toEqual({ data: [] })
      expect(mockStripe.customers.list).toHaveBeenCalledWith({ limit: 10 })
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap customers.create with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.customers.create({ email: 'test@example.com' })

      expect(result).toEqual({ id: 'cus_new' })
      expect(mockStripe.customers.create).toHaveBeenCalledWith({ email: 'test@example.com' })
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap invoices.retrieve with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.invoices.retrieve('in_123')

      expect(result).toEqual({ id: 'in_123' })
      expect(mockStripe.invoices.retrieve).toHaveBeenCalledWith('in_123')
      expect(withRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe('Nested resource methods', () => {
    it('should wrap nested checkout.sessions.retrieve with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.checkout.sessions.retrieve('cs_123')

      expect(result).toEqual({ id: 'cs_123' })
      expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_123')
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap nested checkout.sessions.list with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.checkout.sessions.list()

      expect(result).toEqual({ data: [] })
      expect(mockStripe.checkout.sessions.list).toHaveBeenCalled()
      expect(withRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe('Webhook endpoint operations', () => {
    it('should wrap webhookEndpoints.retrieve with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.webhookEndpoints.retrieve('we_123')

      expect(result).toEqual({ id: 'we_123' })
      expect(mockStripe.webhookEndpoints.retrieve).toHaveBeenCalledWith('we_123')
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap webhookEndpoints.create with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const params = { url: 'https://example.com/webhook', enabled_events: ['*'] }
      const result = await wrapped.webhookEndpoints.create(params)

      expect(result).toEqual({ id: 'we_new' })
      expect(mockStripe.webhookEndpoints.create).toHaveBeenCalledWith(params)
      expect(withRetry).toHaveBeenCalledTimes(1)
    })

    it('should wrap webhookEndpoints.del with retry logic', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      const result = await wrapped.webhookEndpoints.del('we_123')

      expect(result).toEqual({ deleted: true })
      expect(mockStripe.webhookEndpoints.del).toHaveBeenCalledWith('we_123')
      expect(withRetry).toHaveBeenCalledTimes(1)
    })
  })

  describe('Non-API methods', () => {
    it('should NOT wrap non-Promise methods (webhooks.constructEvent)', () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      // constructEvent is synchronous, should not be wrapped
      wrapped.webhooks.constructEvent('payload', 'sig', 'secret')

      expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledWith('payload', 'sig', 'secret')
      // Should not call withRetry for non-Promise methods
      expect(withRetry).not.toHaveBeenCalled()
    })
  })

  describe('Retry configuration', () => {
    it('should pass retry config to withRetry', async () => {
      const retryConfig = { maxRetries: 3, initialDelayMs: 500 }
      const wrapped = createRetryableStripeClient(mockStripe, retryConfig, mockLogger)

      await wrapped.customers.retrieve('cus_123')

      expect(withRetry).toHaveBeenCalledTimes(1)
      const withRetryCall = vi.mocked(withRetry).mock.calls[0]
      expect(withRetryCall[1]).toEqual(retryConfig)
      expect(withRetryCall[2]).toBe(mockLogger)
    })

    it('should pass empty config when not provided', async () => {
      const wrapped = createRetryableStripeClient(mockStripe)

      await wrapped.customers.retrieve('cus_123')

      expect(withRetry).toHaveBeenCalledTimes(1)
      const withRetryCall = vi.mocked(withRetry).mock.calls[0]
      expect(withRetryCall[1]).toEqual({})
      expect(withRetryCall[2]).toBeUndefined()
    })
  })

  describe('Multiple sequential calls', () => {
    it('should wrap each API call independently', async () => {
      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      await wrapped.customers.retrieve('cus_1')
      await wrapped.invoices.retrieve('in_1')
      await wrapped.customers.list()

      expect(withRetry).toHaveBeenCalledTimes(3)
      expect(mockStripe.customers.retrieve).toHaveBeenCalledWith('cus_1')
      expect(mockStripe.invoices.retrieve).toHaveBeenCalledWith('in_1')
      expect(mockStripe.customers.list).toHaveBeenCalled()
    })
  })

  describe('Error handling', () => {
    it('should propagate errors from wrapped methods', async () => {
      const error = new Error('API Error')
      mockStripe.customers.retrieve = vi.fn().mockRejectedValue(error)

      // Mock withRetry to actually call the function and propagate errors
      vi.mocked(withRetry).mockImplementation(async (fn) => {
        return await fn()
      })

      const wrapped = createRetryableStripeClient(mockStripe, {}, mockLogger)

      await expect(wrapped.customers.retrieve('cus_123')).rejects.toThrow('API Error')
      expect(mockStripe.customers.retrieve).toHaveBeenCalledWith('cus_123')
    })
  })
})
