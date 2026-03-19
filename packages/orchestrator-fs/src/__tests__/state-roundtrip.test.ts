import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { FsStateStore } from '../state'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-fs-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('FsStateStore', () => {
  it('round-trips state through save and load', () => {
    const store = new FsStateStore(tmpDir)
    const syncId = 'sync_001'

    store.saveStreamState(syncId, 'customers', { cursor: 'cus_abc', page: 3 })
    store.saveStreamState(syncId, 'invoices', { cursor: 'inv_xyz' })

    const loaded = store.loadState(syncId)
    expect(loaded).toEqual({
      customers: { cursor: 'cus_abc', page: 3 },
      invoices: { cursor: 'inv_xyz' },
    })
  })

  it('returns empty state for unknown sync', () => {
    const store = new FsStateStore(tmpDir)
    const loaded = store.loadState('nonexistent')
    expect(loaded).toEqual({})
  })

  it('overwrites existing stream state', () => {
    const store = new FsStateStore(tmpDir)
    const syncId = 'sync_002'

    store.saveStreamState(syncId, 'customers', { cursor: 'old' })
    store.saveStreamState(syncId, 'customers', { cursor: 'new' })

    const loaded = store.loadState(syncId)
    expect(loaded.customers).toEqual({ cursor: 'new' })
  })

  it('clears all state for a sync', () => {
    const store = new FsStateStore(tmpDir)
    const syncId = 'sync_003'

    store.saveStreamState(syncId, 'customers', { cursor: 'abc' })
    store.saveStreamState(syncId, 'invoices', { cursor: 'xyz' })
    store.clearState(syncId)

    const loaded = store.loadState(syncId)
    expect(loaded).toEqual({})
  })

  it('isolates state between different syncs', () => {
    const store = new FsStateStore(tmpDir)

    store.saveStreamState('sync_a', 'customers', { cursor: 'a' })
    store.saveStreamState('sync_b', 'customers', { cursor: 'b' })

    expect(store.loadState('sync_a')).toEqual({ customers: { cursor: 'a' } })
    expect(store.loadState('sync_b')).toEqual({ customers: { cursor: 'b' } })
  })
})
