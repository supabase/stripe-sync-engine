import { describe, it, expect } from 'vitest'
import { groupStreams, filterStreams, type CatalogStream } from './stream-groups'

function stream(name: string): CatalogStream {
  return { name, primary_key: [['id']] }
}

describe('groupStreams', () => {
  it('groups payment-related streams together', () => {
    const streams = [
      stream('payment_intents'),
      stream('payment_methods'),
      stream('charges'),
      stream('refunds'),
    ]
    const groups = groupStreams(streams)
    const payments = groups.find((g) => g.name === 'Payments')
    expect(payments).toBeDefined()
    expect(payments!.streams.map((s) => s.name)).toEqual(
      expect.arrayContaining(['payment_intents', 'payment_methods', 'charges', 'refunds'])
    )
  })

  it('groups billing-related streams together', () => {
    const streams = [
      stream('subscriptions'),
      stream('subscription_schedules'),
      stream('invoices'),
      stream('prices'),
      stream('plans'),
      stream('coupons'),
      stream('credit_notes'),
    ]
    const groups = groupStreams(streams)
    const billing = groups.find((g) => g.name === 'Billing')
    expect(billing).toBeDefined()
    expect(billing!.streams).toHaveLength(7)
  })

  it('sorts groups alphabetically', () => {
    const streams = [stream('products'), stream('customers'), stream('charges')]
    const groups = groupStreams(streams)
    const names = groups.map((g) => g.name)
    expect(names).toEqual([...names].sort())
  })

  it('sorts streams within a group alphabetically', () => {
    const streams = [stream('refunds'), stream('charges'), stream('disputes')]
    const groups = groupStreams(streams)
    const payments = groups.find((g) => g.name === 'Payments')!
    expect(payments.streams.map((s) => s.name)).toEqual(['charges', 'disputes', 'refunds'])
  })

  it('handles dotted names (v2 resources)', () => {
    const streams = [stream('v2.core.account'), stream('v2.core.person')]
    const groups = groupStreams(streams)
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe('Core')
  })

  it('returns empty array for empty input', () => {
    expect(groupStreams([])).toEqual([])
  })
})

describe('filterStreams', () => {
  const streams = [stream('customers'), stream('charges'), stream('checkout_sessions')]

  it('filters by partial name match', () => {
    expect(filterStreams(streams, 'ch').map((s) => s.name)).toEqual([
      'charges',
      'checkout_sessions',
    ])
  })

  it('is case-insensitive', () => {
    expect(filterStreams(streams, 'CUSTOMER').map((s) => s.name)).toEqual(['customers'])
  })

  it('returns all streams for empty query', () => {
    expect(filterStreams(streams, '')).toEqual(streams)
    expect(filterStreams(streams, '  ')).toEqual(streams)
  })

  it('returns empty for no matches', () => {
    expect(filterStreams(streams, 'zzz')).toEqual([])
  })
})
