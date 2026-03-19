import { describe, expect, it } from 'vitest'
import { toRecordMessage, fromRecordMessage } from '@stripe/sync-protocol'

describe('toRecordMessage', () => {
  it('produces the correct shape', () => {
    const before = Date.now()
    const msg = toRecordMessage('customers', { id: 'cus_123', name: 'Alice' })
    const after = Date.now()

    expect(msg.type).toBe('record')
    expect(msg.stream).toBe('customers')
    expect(msg.data).toEqual({ id: 'cus_123', name: 'Alice' })
    expect(msg.emitted_at).toBeGreaterThanOrEqual(before)
    expect(msg.emitted_at).toBeLessThanOrEqual(after)
  })
})

describe('fromRecordMessage', () => {
  it('extracts the raw data', () => {
    const msg = toRecordMessage('invoices', { id: 'inv_456', amount: 1000 })
    const data = fromRecordMessage(msg)

    expect(data).toEqual({ id: 'inv_456', amount: 1000 })
  })

  it('roundtrips correctly', () => {
    const original = { id: 'sub_789', status: 'active', items: [1, 2, 3] }
    const msg = toRecordMessage('subscriptions', original)
    const result = fromRecordMessage(msg)

    expect(result).toEqual(original)
  })
})
