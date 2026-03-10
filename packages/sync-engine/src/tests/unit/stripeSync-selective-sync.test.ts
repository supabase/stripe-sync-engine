import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMockedStripeSync } from '../testSetup'

describe('selective sync / webhook object filter', () => {
  it('should skip events for objects not in the filter', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stripeSync = await createMockedStripeSync({ logger })

    stripeSync.webhook.setObjectFilter(['customer'])

    const upsertSpy = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_filtered_out',
      type: 'product.updated',
      data: { object: { id: 'prod_1', object: 'product' } },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await stripeSync.webhook.processEvent(event)

    expect(upsertSpy).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not in sync filter'))
  })

  it('should process events for objects that are in the filter', async () => {
    const stripeSync = await createMockedStripeSync()

    stripeSync.webhook.setObjectFilter(['customer'])

    const upsertSpy = vi.fn().mockResolvedValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_allowed',
      type: 'customer.updated',
      data: { object: { id: 'cus_1', object: 'customer' } },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await stripeSync.webhook.processEvent(event)

    expect(upsertSpy).toHaveBeenCalledWith(
      [event.data.object],
      'acct_test',
      false,
      expect.any(String)
    )
  })

  it('should process all events when no filter is set', async () => {
    const stripeSync = await createMockedStripeSync()

    stripeSync.webhook.setObjectFilter(null)

    const upsertSpy = vi.fn().mockResolvedValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_no_filter',
      type: 'product.created',
      data: { object: { id: 'prod_1', object: 'product' } },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await stripeSync.webhook.processEvent(event)

    expect(upsertSpy).toHaveBeenCalled()
  })
})
