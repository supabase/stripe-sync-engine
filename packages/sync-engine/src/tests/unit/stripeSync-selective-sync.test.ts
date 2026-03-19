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
      [
        expect.objectContaining({
          type: 'record',
          stream: 'customer',
          data: event.data.object,
        }),
      ],
      'acct_test',
      false,
      expect.any(String)
    )
  })

  it('should skip unsupported objects before account lookup or writes', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const stripeSync = await createMockedStripeSync({ logger })

    const getAccountIdSpy = vi.fn().mockResolvedValue('acct_test')
    const upsertSpy = vi.fn()
    const deleteSpy = vi.fn().mockResolvedValue(undefined)
    const columnExistsSpy = vi.fn().mockResolvedValue(false)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.getAccountId = getAccountIdSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.writer.delete = deleteSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.writer.columnExists = columnExistsSpy

    const event = {
      id: 'evt_person_updated',
      type: 'person.updated',
      data: { object: { id: 'person_123', object: 'person', account: 'acct_connect' } },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(getAccountIdSpy).not.toHaveBeenCalled()
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(columnExistsSpy).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('object type "person" is not supported')
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
