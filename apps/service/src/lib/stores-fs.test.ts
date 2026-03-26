import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { filePipelineStore, fileStateStore, fileLogSink } from './stores-fs.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'stores-fs-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pipeline store
// ---------------------------------------------------------------------------

describe('filePipelineStore', () => {
  it('creates dir and writes $id.json per pipeline', async () => {
    const dir = join(tmpDir, 'pipelines')
    const store = filePipelineStore(dir)

    const pipeline = {
      id: 'pipe_1',
      source: { type: 'stripe', api_key: 'sk_test_123' },
      destination: { type: 'postgres', connection_string: 'postgres://localhost/db' },
    }
    await store.set('pipe_1', pipeline)

    // File exists at $dir/pipe_1.json
    expect(existsSync(join(dir, 'pipe_1.json'))).toBe(true)
    const ondisk = JSON.parse(readFileSync(join(dir, 'pipe_1.json'), 'utf-8'))
    expect(ondisk.source.api_key).toBe('sk_test_123')
  })

  it('get returns the stored pipeline', async () => {
    const store = filePipelineStore(join(tmpDir, 'pipelines'))

    const pipeline = {
      id: 'pipe_a',
      source: { type: 'stripe', api_key: 'sk_test_abc' },
      destination: { type: 'postgres', connection_string: 'postgres://localhost/db' },
    }
    await store.set('pipe_a', pipeline)

    const got = await store.get('pipe_a')
    expect(got).toEqual(pipeline)
  })

  it('get throws for missing id', async () => {
    const store = filePipelineStore(join(tmpDir, 'pipelines'))
    await expect(store.get('nope')).rejects.toThrow('Pipeline not found: nope')
  })

  it('list returns all pipelines', async () => {
    const store = filePipelineStore(join(tmpDir, 'pipelines'))

    await store.set('a', { id: 'a', source: { type: 's' }, destination: { type: 'd' } })
    await store.set('b', { id: 'b', source: { type: 's' }, destination: { type: 'd' } })

    const list = await store.list()
    expect(list).toHaveLength(2)
    expect(list.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('list returns empty array when dir does not exist', async () => {
    const store = filePipelineStore(join(tmpDir, 'nonexistent'))
    expect(await store.list()).toEqual([])
  })

  it('delete removes the file', async () => {
    const dir = join(tmpDir, 'pipelines')
    const store = filePipelineStore(dir)

    await store.set('x', { id: 'x', source: { type: 's' }, destination: { type: 'd' } })
    expect(existsSync(join(dir, 'x.json'))).toBe(true)

    await store.delete('x')
    expect(existsSync(join(dir, 'x.json'))).toBe(false)
  })

  it('delete is a no-op for missing id', async () => {
    const store = filePipelineStore(join(tmpDir, 'pipelines'))
    await store.delete('nope') // should not throw
  })
})

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

describe('fileStateStore', () => {
  it('get returns undefined when no state exists', async () => {
    const store = fileStateStore(join(tmpDir, 'state'))
    expect(await store.get('pipe_1')).toBeUndefined()
  })

  it('set creates $pipelineId.json with stream cursors', async () => {
    const dir = join(tmpDir, 'state')
    const store = fileStateStore(dir)

    await store.set('pipe_1', 'products', { cursor: 'prod_100' })
    await store.set('pipe_1', 'customers', { cursor: 'cus_200' })

    const state = await store.get('pipe_1')
    expect(state).toEqual({
      products: { cursor: 'prod_100' },
      customers: { cursor: 'cus_200' },
    })

    // On disk as pipe_1.json
    expect(existsSync(join(dir, 'pipe_1.json'))).toBe(true)
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

    sink.write('pipe_1', { level: 'info', message: 'started', timestamp: 't1' })
    sink.write('pipe_2', { level: 'debug', message: 'checkpoint', stream: 'p', timestamp: 't2' })

    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0]!)
    expect(first.pipelineId).toBe('pipe_1')
    expect(first.level).toBe('info')

    const second = JSON.parse(lines[1]!)
    expect(second.pipelineId).toBe('pipe_2')
    expect(second.stream).toBe('p')
  })
})
