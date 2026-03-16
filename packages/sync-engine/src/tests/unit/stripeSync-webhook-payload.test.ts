import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMockedStripeSync } from '../testSetup'

describe('webhook payload handling', () => {
  it('passes Uint8Array payloads directly to Stripe when Buffer is unavailable', async () => {
    const stripeSync = await createMockedStripeSync({
      stripeWebhookSecret: 'whsec_test',
    })

    const payload = new TextEncoder().encode(JSON.stringify({ id: 'evt_test' }))
    const event = {
      id: 'evt_test',
      type: 'customer.created',
      data: { object: { id: 'cus_test', object: 'customer' } },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    const constructEventAsync = vi.fn().mockResolvedValue(event)
    const processEventSpy = vi
      .spyOn(stripeSync.webhook, 'processEvent')
      .mockResolvedValue(undefined)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.stripe.webhooks.constructEventAsync = constructEventAsync

    vi.stubGlobal('Buffer', undefined)

    try {
      await expect(stripeSync.webhook.processWebhook(payload, 'sig_test')).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }

    expect(constructEventAsync).toHaveBeenCalledWith(payload, 'sig_test', 'whsec_test')
    expect(constructEventAsync.mock.contexts[0]).toBe(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stripeSync.webhook as any).deps.stripe.webhooks
    )
    expect(processEventSpy).toHaveBeenCalledWith(event)
  })
})
