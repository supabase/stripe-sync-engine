import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Credential,
  CredentialStore,
  SyncConfig,
  ConfigStore,
  StateStore,
  LogSink,
} from '../stores'

// MARK: - Helpers

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

// MARK: - File-backed credential store

export function fileCredentialStore(filePath: string): CredentialStore {
  return {
    async get(id) {
      const store = loadJson<Credential>(filePath)
      const cred = store[id]
      if (!cred) throw new Error(`Credential not found: ${id}`)
      return cred
    },
    async set(id, credential) {
      const store = loadJson<Credential>(filePath)
      store[id] = credential
      saveJson(filePath, store)
    },
    async delete(id) {
      const store = loadJson<Credential>(filePath)
      delete store[id]
      saveJson(filePath, store)
    },
    async list() {
      return Object.values(loadJson<Credential>(filePath))
    },
  }
}

// MARK: - File-backed config store

export function fileConfigStore(filePath: string): ConfigStore {
  return {
    async get(id) {
      const store = loadJson<SyncConfig>(filePath)
      const config = store[id]
      if (!config) throw new Error(`SyncConfig not found: ${id}`)
      return config
    },
    async set(id, config) {
      const store = loadJson<SyncConfig>(filePath)
      store[id] = config
      saveJson(filePath, store)
    },
    async delete(id) {
      const store = loadJson<SyncConfig>(filePath)
      delete store[id]
      saveJson(filePath, store)
    },
    async list() {
      return Object.values(loadJson<SyncConfig>(filePath))
    },
  }
}

// MARK: - File-backed state store

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

// MARK: - File-backed log sink (append NDJSON)

export function fileLogSink(filePath: string): LogSink {
  return {
    write(syncId, entry) {
      ensureDir(filePath)
      const line = JSON.stringify({ syncId, ...entry }) + '\n'
      writeFileSync(filePath, line, { flag: 'a' })
    },
  }
}
