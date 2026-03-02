import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMockedStripeSync } from '../testSetup'

/**
 * Unit tests for invoice.upcoming handling.
 *
 * invoice.upcoming IS a supported event type (so the webhook endpoint receives it),
 * but processWebhook skips events whose data.object lacks an id — these are
 * preview/draft objects that cannot be persisted (NOT NULL constraint on id).
 */

describe('invoice.upcoming handling', () => {
  it('should include invoice.upcoming in supported event types so the webhook receives it', async () => {
    const stripeSync = await createMockedStripeSync()
    const supportedEvents = stripeSync.webhook.getSupportedEventTypes()
    expect(supportedEvents).toContain('invoice.upcoming')
  })

  it('should include other invoice events in supported event types', async () => {
    const stripeSync = await createMockedStripeSync()
    const supportedEvents = stripeSync.webhook.getSupportedEventTypes()
    expect(supportedEvents).toContain('invoice.created')
    expect(supportedEvents).toContain('invoice.paid')
    expect(supportedEvents).toContain('invoice.finalized')
    expect(supportedEvents).toContain('invoice.updated')
  })

  it('should skip events whose data.object has no id', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const stripeSync = await createMockedStripeSync({ logger })

    const upsertSpy = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_test_upcoming',
      type: 'invoice.upcoming',
      data: {
        object: {
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          subscription: 'sub_test123',
          total: 10000,
          // No 'id' field — this is a preview invoice
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(upsertSpy).not.toHaveBeenCalled()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping webhook evt_test_upcoming')
    )
  })

  it('should process normal invoice events that have an id', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const stripeSync = await createMockedStripeSync({ logger })

    const upsertSpy = vi.fn().mockResolvedValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_test_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test123',
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          status: 'paid',
          total: 10000,
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(upsertSpy).toHaveBeenCalledWith(
      [event.data.object],
      'acct_test',
      false,
      expect.any(String)
    )
  })
})
