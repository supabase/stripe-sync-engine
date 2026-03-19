import { describe, expect, it } from 'vitest'
import { syncFromBridgeInput, type SyncBridgeInput } from '../../sync'

function makeInput(overrides?: Partial<SyncBridgeInput>): SyncBridgeInput {
  return {
    accountId: 'acct_123',
    runStartedAt: new Date('2025-01-15T10:00:00Z'),
    apiVersion: '2024-12-18.acacia',
    livemode: true,
    apiKeyHash: 'sk_hash_abc',
    schemaName: 'stripe',
    destinationCredentialId: 'pg_cred_1',
    runClosed: false,
    hasErrors: false,
    ...overrides,
  }
}

describe('syncFromBridgeInput', () => {
  it('returns a Sync with all required fields from minimal input', () => {
    const input = makeInput()
    const sync = syncFromBridgeInput(input)

    expect(sync.id).toBe(`sync_acct_123_${new Date('2025-01-15T10:00:00Z').getTime()}`)
    expect(sync.account_id).toBe('acct_123')
    expect(sync.status).toBe('backfilling')
    expect(sync.source).toEqual({
      type: 'stripe-api-core',
      livemode: true,
      api_version: '2024-12-18.acacia',
      credential_id: 'sk_hash_abc',
    })
    expect(sync.destination).toEqual({
      type: 'postgres',
      schema_name: 'stripe',
      credential_id: 'pg_cred_1',
    })
  })

  it('omits streams when streamNames is undefined', () => {
    const sync = syncFromBridgeInput(makeInput({ streamNames: undefined }))
    expect(sync.streams).toBeUndefined()
  })

  it('omits streams when streamNames is empty', () => {
    const sync = syncFromBridgeInput(makeInput({ streamNames: [] }))
    expect(sync.streams).toBeUndefined()
  })

  it('sets streams when streamNames are provided', () => {
    const sync = syncFromBridgeInput(makeInput({ streamNames: ['customers', 'invoices'] }))
    expect(sync.streams).toEqual([{ name: 'customers' }, { name: 'invoices' }])
  })

  it('omits state when state is undefined', () => {
    const sync = syncFromBridgeInput(makeInput({ state: undefined }))
    expect(sync.state).toBeUndefined()
  })

  it('omits state when state is empty', () => {
    const sync = syncFromBridgeInput(makeInput({ state: {} }))
    expect(sync.state).toBeUndefined()
  })

  it('sets state when state has entries', () => {
    const state = { customers: { after: 'cus_999' } }
    const sync = syncFromBridgeInput(makeInput({ state }))
    expect(sync.state).toEqual(state)
  })

  describe('status derivation', () => {
    it('returns error when hasErrors is true', () => {
      const sync = syncFromBridgeInput(makeInput({ hasErrors: true, runClosed: false }))
      expect(sync.status).toBe('error')
    })

    it('returns error when hasErrors is true even if run is closed', () => {
      const sync = syncFromBridgeInput(makeInput({ hasErrors: true, runClosed: true }))
      expect(sync.status).toBe('error')
    })

    it('returns backfilling when run is not closed and no errors', () => {
      const sync = syncFromBridgeInput(makeInput({ hasErrors: false, runClosed: false }))
      expect(sync.status).toBe('backfilling')
    })

    it('returns syncing when run is closed and no errors', () => {
      const sync = syncFromBridgeInput(makeInput({ hasErrors: false, runClosed: true }))
      expect(sync.status).toBe('syncing')
    })
  })
})
