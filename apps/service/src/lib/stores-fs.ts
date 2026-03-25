import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import type { Credential, SyncConfig } from './schemas.js'
import type { CredentialStore, ConfigStore, LogSink } from './stores.js'
import type { StateStore } from '@stripe/sync-engine'

// MARK: - Helpers

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readItem<T>(dir: string, id: string): T | undefined {
  const filePath = join(dir, `${id}.json`)
  if (!existsSync(filePath)) return undefined
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

function writeItem(dir: string, id: string, data: unknown): void {
  ensureDir(dir)
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(data, null, 2) + '\n')
}

function removeItem(dir: string, id: string): void {
  const filePath = join(dir, `${id}.json`)
  if (existsSync(filePath)) unlinkSync(filePath)
}

function listItems<T>(dir: string): T[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as T)
}

// MARK: - File-backed credential store

export function fileCredentialStore(dir: string): CredentialStore {
  return {
    async get(id) {
      const cred = readItem<Credential>(dir, id)
      if (!cred) throw new Error(`Credential not found: ${id}`)
      return cred
    },
    async set(id, credential) {
      writeItem(dir, id, credential)
    },
    async delete(id) {
      removeItem(dir, id)
    },
    async list() {
      return listItems<Credential>(dir)
    },
  }
}

// MARK: - File-backed config store

export function fileConfigStore(dir: string): ConfigStore {
  return {
    async get(id) {
      const config = readItem<SyncConfig>(dir, id)
      if (!config) throw new Error(`SyncConfig not found: ${id}`)
      return config
    },
    async set(id, config) {
      writeItem(dir, id, config)
    },
    async delete(id) {
      removeItem(dir, id)
    },
    async list() {
      return listItems<SyncConfig>(dir)
    },
  }
}

// MARK: - File-backed state store

export function fileStateStore(dir: string): StateStore {
  return {
    async get(syncId) {
      return readItem<Record<string, unknown>>(dir, syncId)
    },
    async set(syncId, stream, data) {
      const state = readItem<Record<string, unknown>>(dir, syncId) ?? {}
      state[stream] = data
      writeItem(dir, syncId, state)
    },
    async clear(syncId) {
      removeItem(dir, syncId)
    },
  }
}

// MARK: - File-backed log sink (append NDJSON)

export function fileLogSink(filePath: string): LogSink {
  return {
    write(syncId, entry) {
      const dir = join(filePath, '..')
      ensureDir(dir)
      const line = JSON.stringify({ syncId, ...entry }) + '\n'
      writeFileSync(filePath, line, { flag: 'a' })
    },
  }
}
