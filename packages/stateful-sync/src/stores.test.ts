import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fileCredentialStore, fileConfigStore, fileStateStore, fileLogSink } from './stores/file.js'
import {
  memoryCredentialStore,
  memoryConfigStore,
  memoryStateStore,
  memoryLogSink,
} from './stores/memory.js'
import type { Credential, SyncConfig } from './stores.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredential(id: string, overrides?: Partial<Credential>): Credential {
  return {
    id,
    type: 'test',
    key: 'value',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeConfig(id: string): SyncConfig {
  return {
    id,
    source: { type: 'stdin', credential_id: 'src' },
    destination: { type: 'postgres', credential_id: 'dst' },
  }
}

// ---------------------------------------------------------------------------
// File credential store
// ---------------------------------------------------------------------------

describe('fileCredentialStore', () => {
  let filePath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-test-'))
    filePath = join(dir, 'credentials.json')
  })

  it('CRUD roundtrip', async () => {
    const store = fileCredentialStore(filePath)
    const cred = makeCredential('cred-1')

    await store.set('cred-1', cred)
    expect(await store.get('cred-1')).toEqual(cred)
    expect(await store.list()).toHaveLength(1)

    await store.delete('cred-1')
    expect(await store.list()).toHaveLength(0)
  })

  it('throws on missing credential', async () => {
    const store = fileCredentialStore(filePath)
    await expect(store.get('nonexistent')).rejects.toThrow('Credential not found: nonexistent')
  })
})

// ---------------------------------------------------------------------------
// File config store
// ---------------------------------------------------------------------------

describe('fileConfigStore', () => {
  let filePath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-test-'))
    filePath = join(dir, 'configs.json')
  })

  it('CRUD roundtrip', async () => {
    const store = fileConfigStore(filePath)
    const config = makeConfig('sync-1')

    await store.set('sync-1', config)
    expect(await store.get('sync-1')).toEqual(config)
    expect(await store.list()).toHaveLength(1)

    await store.delete('sync-1')
    expect(await store.list()).toHaveLength(0)
  })

  it('throws on missing config', async () => {
    const store = fileConfigStore(filePath)
    await expect(store.get('nonexistent')).rejects.toThrow('SyncConfig not found: nonexistent')
  })
})

// ---------------------------------------------------------------------------
// File state store
// ---------------------------------------------------------------------------

describe('fileStateStore', () => {
  let filePath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-test-'))
    filePath = join(dir, 'state.json')
  })

  it('get/set/clear', async () => {
    const store = fileStateStore(filePath)

    expect(await store.get('sync-1')).toBeUndefined()

    await store.set('sync-1', 'customers', { cursor: 'abc' })
    expect(await store.get('sync-1')).toEqual({ customers: { cursor: 'abc' } })

    await store.clear('sync-1')
    expect(await store.get('sync-1')).toBeUndefined()
  })

  it('per-stream updates', async () => {
    const store = fileStateStore(filePath)

    await store.set('sync-1', 'customers', { cursor: 'c1' })
    await store.set('sync-1', 'invoices', { cursor: 'i1' })
    expect(await store.get('sync-1')).toEqual({
      customers: { cursor: 'c1' },
      invoices: { cursor: 'i1' },
    })

    await store.set('sync-1', 'customers', { cursor: 'c2' })
    expect(await store.get('sync-1')).toEqual({
      customers: { cursor: 'c2' },
      invoices: { cursor: 'i1' },
    })
  })
})

// ---------------------------------------------------------------------------
// File log sink
// ---------------------------------------------------------------------------

describe('fileLogSink', () => {
  let filePath: string

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-test-'))
    filePath = join(dir, 'logs.ndjson')
  })

  it('appends NDJSON lines', () => {
    const sink = fileLogSink(filePath)

    sink.write('sync-1', {
      level: 'info',
      message: 'hello',
      timestamp: '2024-01-01T00:00:00Z',
    })
    sink.write('sync-1', {
      level: 'warn',
      message: 'world',
      stream: 'customers',
      timestamp: '2024-01-01T00:00:01Z',
    })

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const entry1 = JSON.parse(lines[0]!)
    expect(entry1.syncId).toBe('sync-1')
    expect(entry1.level).toBe('info')
    expect(entry1.message).toBe('hello')

    const entry2 = JSON.parse(lines[1]!)
    expect(entry2.stream).toBe('customers')
  })
})

// ---------------------------------------------------------------------------
// Memory stores
// ---------------------------------------------------------------------------

describe('memory stores', () => {
  it('memoryCredentialStore CRUD', async () => {
    const store = memoryCredentialStore()
    const cred = makeCredential('cred-1')

    await store.set('cred-1', cred)
    expect(await store.get('cred-1')).toEqual(cred)
    expect(await store.list()).toHaveLength(1)

    await store.delete('cred-1')
    await expect(store.get('cred-1')).rejects.toThrow('Credential not found')
  })

  it('memoryConfigStore CRUD', async () => {
    const store = memoryConfigStore()
    const config = makeConfig('sync-1')

    await store.set('sync-1', config)
    expect(await store.get('sync-1')).toEqual(config)
    expect(await store.list()).toHaveLength(1)

    await store.delete('sync-1')
    await expect(store.get('sync-1')).rejects.toThrow('SyncConfig not found')
  })

  it('memoryStateStore get/set/clear', async () => {
    const store = memoryStateStore()

    expect(await store.get('sync-1')).toBeUndefined()

    await store.set('sync-1', 'customers', { cursor: 'abc' })
    expect(await store.get('sync-1')).toEqual({ customers: { cursor: 'abc' } })

    await store.clear('sync-1')
    expect(await store.get('sync-1')).toBeUndefined()
  })

  it('memoryLogSink collects entries', () => {
    const sink = memoryLogSink()
    sink.write('sync-1', {
      level: 'info',
      message: 'test',
      timestamp: '2024-01-01T00:00:00Z',
    })
    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]!.message).toBe('test')
  })
})
