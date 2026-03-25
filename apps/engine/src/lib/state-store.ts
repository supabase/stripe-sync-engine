import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// MARK: - Interface

export interface StateStore {
  get(syncId: string): Promise<Record<string, unknown> | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
  close?(): Promise<void>
}

// MARK: - File-backed state store

function ensureDir(filePath: string) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function loadJson<T>(path: string): Record<string, T> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function saveJson(path: string, data: unknown): void {
  ensureDir(path)
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

export function fileStateStore(filePath: string): StateStore {
  return {
    async get(syncId) {
      const store = loadJson<Record<string, unknown>>(filePath)
      return store[syncId]
    },
    async set(syncId, stream, data) {
      const store = loadJson<Record<string, unknown>>(filePath)
      if (!store[syncId]) store[syncId] = {}
      ;(store[syncId] as Record<string, unknown>)[stream] = data
      saveJson(filePath, store)
    },
    async clear(syncId) {
      const store = loadJson<Record<string, unknown>>(filePath)
      delete store[syncId]
      saveJson(filePath, store)
    },
  }
}

// MARK: - In-memory state store (for tests)

export function memoryStateStore(): StateStore {
  const store = new Map<string, Record<string, unknown>>()

  return {
    async get(syncId) {
      return store.get(syncId)
    },
    async set(syncId, stream, data) {
      let state = store.get(syncId)
      if (!state) {
        state = {}
        store.set(syncId, state)
      }
      state[stream] = data
    },
    async clear(syncId) {
      store.delete(syncId)
    },
  }
}
