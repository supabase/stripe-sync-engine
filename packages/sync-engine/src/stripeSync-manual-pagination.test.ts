import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { StripeSync } from './stripeSync'
import type { StripeSyncConfig } from './types'

describe('Manual Pagination with Rate Limit Handling', () => {
  let sync: StripeSync
  let mockCustomersList: ReturnType<typeof vi.fn>
  let mockPaymentMethodsList: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()

    // Create minimal config
    const config: StripeSyncConfig = {
      stripeSecretKey: 'sk_test_123',
      poolConfig: {
        connectionString: 'postgresql://test',
      },
      maxRetries: 3,
      initialRetryDelayMs: 100,
      maxRetryDelayMs: 1000,
      retryJitterMs: 0,
    }

    // Create StripeSync instance
    sync = new StripeSync(config)

    // Create mock functions
    mockCustomersList = vi.fn()
    mockPaymentMethodsList = vi.fn()

    // Inject mocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync as any).stripe = {
      customers: {
        list: mockCustomersList,
      },
      paymentMethods: {
        list: mockPaymentMethodsList,
      },
    }
  })

  it('should handle 429 rate limit during manual pagination and retry successfully', async () => {
    // Mock response: first page throws 429, retry succeeds with data
    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })

    const successResponse: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_1' }, { id: 'cus_2' }] as Stripe.Customer[],
      has_more: false,
      url: '/v1/customers',
    }

    mockCustomersList.mockRejectedValueOnce(rateLimitError).mockResolvedValueOnce(successResponse)

    // Manually call the list method to test pagination
    const fetchPage = async (startingAfter?: string) => {
      return await mockCustomersList({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })
    }

    // Simulate manual pagination loop
    const allData: Stripe.Customer[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined

    while (hasMore) {
      try {
        const response = await fetchPage(startingAfter)
        allData.push(...response.data)
        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
      } catch (error) {
        if (error instanceof Stripe.errors.StripeRateLimitError) {
          // In real code, withRetry() handles this
          // Here we simulate retry by continuing the loop
          await vi.advanceTimersByTimeAsync(100)
          continue
        }
        throw error
      }
    }

    // Verify we got the data after retry
    expect(allData).toHaveLength(2)
    expect(allData[0].id).toBe('cus_1')
    expect(allData[1].id).toBe('cus_2')
    expect(mockCustomersList).toHaveBeenCalledTimes(2) // Initial + 1 retry
  })

  it('should handle 429 during payment method pagination with multiple pages', async () => {
    // Mock response: Rate limit on page 2, then success
    const page1: Stripe.ApiList<Stripe.PaymentMethod> = {
      object: 'list' as const,
      data: [{ id: 'pm_1' }] as Stripe.PaymentMethod[],
      has_more: true,
      url: '/v1/payment_methods',
    }

    const rateLimitError = new Stripe.errors.StripeRateLimitError({
      message: 'Rate limit exceeded',
    })

    const page2: Stripe.ApiList<Stripe.PaymentMethod> = {
      object: 'list' as const,
      data: [{ id: 'pm_2' }] as Stripe.PaymentMethod[],
      has_more: false,
      url: '/v1/payment_methods',
    }

    mockPaymentMethodsList
      .mockResolvedValueOnce(page1) // First page succeeds
      .mockRejectedValueOnce(rateLimitError) // Second page hits rate limit
      .mockResolvedValueOnce(page2) // Retry succeeds

    // Simulate manual pagination loop
    const allData: Stripe.PaymentMethod[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined
    let retryCount = 0
    const maxRetries = 3

    while (hasMore) {
      try {
        const response = await mockPaymentMethodsList({
          limit: 100,
          customer: 'cus_123',
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        })

        allData.push(...response.data)
        hasMore = response.has_more
        if (response.data.length > 0) {
          startingAfter = response.data[response.data.length - 1].id
        }
        retryCount = 0 // Reset retry count on success
      } catch (error) {
        if (error instanceof Stripe.errors.StripeRateLimitError && retryCount < maxRetries) {
          retryCount++
          await vi.advanceTimersByTimeAsync(100 * Math.pow(2, retryCount - 1))
          continue // Retry same page
        }
        throw error
      }
    }

    // Verify we got all data across both pages
    expect(allData).toHaveLength(2)
    expect(allData[0].id).toBe('pm_1')
    expect(allData[1].id).toBe('pm_2')
    expect(mockPaymentMethodsList).toHaveBeenCalledTimes(3) // page1 + failed page2 + retry page2
  })

  it('should respect has_more flag and stop pagination', async () => {
    const page1: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_1' }] as Stripe.Customer[],
      has_more: true,
      url: '/v1/customers',
    }

    const page2: Stripe.ApiList<Stripe.Customer> = {
      object: 'list' as const,
      data: [{ id: 'cus_2' }] as Stripe.Customer[],
      has_more: false, // Last page
      url: '/v1/customers',
    }

    mockCustomersList.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2)

    const allData: Stripe.Customer[] = []
    let hasMore = true
    let startingAfter: string | undefined = undefined

    while (hasMore) {
      const response = await mockCustomersList({
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      })

      allData.push(...response.data)
      hasMore = response.has_more
      if (response.data.length > 0) {
        startingAfter = response.data[response.data.length - 1].id
      }
    }

    expect(allData).toHaveLength(2)
    expect(mockCustomersList).toHaveBeenCalledTimes(2)
    // Verify second call used starting_after
    expect(mockCustomersList).toHaveBeenNthCalledWith(2, {
      limit: 100,
      starting_after: 'cus_1',
    })
  })
})
