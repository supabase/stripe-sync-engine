import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { fileCredentialStore, fileConfigStore, fileStateStore, fileLogSink } from './stores-fs.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stores-fs-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

describe('fileCredentialStore', () => {
  it('creates dir and writes $id.json per credential', async () => {
    const dir = join(tmpDir, 'credentials')
    const store = fileCredentialStore(dir)

    const cred = {
      id: 'cred_1',
      type: 'stripe',
      api_key: 'sk_test_123',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    await store.set('cred_1', cred)

    // File exists at $dir/cred_1.json
    expect(existsSync(join(dir, 'cred_1.json'))).toBe(true)
    const ondisk = JSON.parse(readFileSync(join(dir, 'cred_1.json'), 'utf-8'))
    expect(ondisk.api_key).toBe('sk_test_123')
  })

  it('get returns the stored credential', async () => {
    const store = fileCredentialStore(join(tmpDir, 'creds'))

    const cred = {
      id: 'cred_a',
      type: 'postgres',
      connection_string: 'postgres://localhost/db',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    await store.set('cred_a', cred)

    const got = await store.get('cred_a')
    expect(got).toEqual(cred)
  })

  it('get throws for missing id', async () => {
    const store = fileCredentialStore(join(tmpDir, 'creds'))
    await expect(store.get('nope')).rejects.toThrow('Credential not found: nope')
  })

  it('list returns all credentials', async () => {
    const store = fileCredentialStore(join(tmpDir, 'creds'))

    await store.set('a', { id: 'a', type: 't', created_at: '', updated_at: '' })
    await store.set('b', { id: 'b', type: 't', created_at: '', updated_at: '' })

    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list.map((c) => c.id).sort()).toEqual(['a', 'b'])
  })

  it('list returns empty array when dir does not exist', async () => {
    const store = fileCredentialStore(join(tmpDir, 'nonexistent'))
    expect(await store.list()).toEqual([])
  })

  it('delete removes the file', async () => {
    const dir = join(tmpDir, 'creds')
    const store = fileCredentialStore(dir)

    await store.set('x', { id: 'x', type: 't', created_at: '', updated_at: '' })
    expect(existsSync(join(dir, 'x.json'))).toBe(true)

    await store.delete('x')
    expect(existsSync(join(dir, 'x.json'))).toBe(false)
  })

  it('delete is a no-op for missing id', async () => {
    const store = fileCredentialStore(join(tmpDir, 'creds'))
    await store.delete('nope') // should not throw
  })
})

// ---------------------------------------------------------------------------
// Config store
// ---------------------------------------------------------------------------

describe('fileConfigStore', () => {
  it('round-trips a sync config via $id.json', async () => {
    const dir = join(tmpDir, 'syncs')
    const store = fileConfigStore(dir)

    const config = {
      id: 'sync_1',
      source: { type: 'stripe' },
      destination: { type: 'postgres' },
      streams: [{ name: 'products' }],
    }
    await store.set('sync_1', config)

    expect(existsSync(join(dir, 'sync_1.json'))).toBe(true)
    expect(await store.get('sync_1')).toEqual(config)
  })

  it('get throws for missing id', async () => {
    const store = fileConfigStore(join(tmpDir, 'syncs'))
    await expect(store.get('nope')).rejects.toThrow('SyncConfig not found: nope')
  })

  it('list returns all configs', async () => {
    const store = fileConfigStore(join(tmpDir, 'syncs'))

    await store.set('s1', { id: 's1', source: { type: 'a' }, destination: { type: 'b' } })
    await store.set('s2', { id: 's2', source: { type: 'c' }, destination: { type: 'd' } })

    const list = await store.list()
    expect(list).toHaveLength(2)
  })

  it('delete removes the file', async () => {
    const dir = join(tmpDir, 'syncs')
    const store = fileConfigStore(dir)

    await store.set('s1', { id: 's1', source: { type: 'a' }, destination: { type: 'b' } })
    await store.delete('s1')
    expect(existsSync(join(dir, 's1.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

describe('fileStateStore', () => {
  it('get returns undefined when no state exists', async () => {
    const store = fileStateStore(join(tmpDir, 'state'))
    expect(await store.get('sync_1')).toBeUndefined()
  })

  it('set creates $syncId.json with stream cursors', async () => {
    const dir = join(tmpDir, 'state')
    const store = fileStateStore(dir)

    await store.set('sync_1', 'products', { cursor: 'prod_100' })
    await store.set('sync_1', 'customers', { cursor: 'cus_200' })

    const state = await store.get('sync_1')
    expect(state).toEqual({
      products: { cursor: 'prod_100' },
      customers: { cursor: 'cus_200' },
    })

    // On disk as sync_1.json
    expect(existsSync(join(dir, 'sync_1.json'))).toBe(true)
  })

  it('set overwrites a single stream cursor without losing others', async () => {
    const store = fileStateStore(join(tmpDir, 'state'))

    await store.set('s', 'a', { v: 1 })
    await store.set('s', 'b', { v: 2 })
    await store.set('s', 'a', { v: 3 })

    expect(await store.get('s')).toEqual({ a: { v: 3 }, b: { v: 2 } })
  })

  it('clear removes the file', async () => {
    const dir = join(tmpDir, 'state')
    const store = fileStateStore(dir)

    await store.set('s', 'x', { v: 1 })
    await store.clear('s')
    expect(await store.get('s')).toBeUndefined()
    expect(existsSync(join(dir, 's.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Log sink
// ---------------------------------------------------------------------------

describe('fileLogSink', () => {
  it('appends NDJSON lines', () => {
    const filePath = join(tmpDir, 'logs.ndjson')
    const sink = fileLogSink(filePath)

    sink.write('sync_1', { level: 'info', message: 'started', timestamp: 't1' })
    sink.write('sync_2', { level: 'debug', message: 'checkpoint', stream: 'p', timestamp: 't2' })

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0]!)
    expect(first.syncId).toBe('sync_1')
    expect(first.level).toBe('info')

    const second = JSON.parse(lines[1]!)
    expect(second.syncId).toBe('sync_2')
    expect(second.stream).toBe('p')
  })
})
