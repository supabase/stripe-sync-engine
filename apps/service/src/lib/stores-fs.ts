import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Pipeline } from './schemas.js'
import type { PipelineStore, LogSink } from './stores.js'
import type { StateStore } from './stores.js'

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

// MARK: - File-backed pipeline store

export function filePipelineStore(dir: string): PipelineStore {
  return {
    async get(id) {
      const pipeline = readItem<Pipeline>(dir, id)
      if (!pipeline) throw new Error(`Pipeline not found: ${id}`)
      return pipeline
    },
    async set(id, pipeline) {
      writeItem(dir, id, pipeline)
    },
    async delete(id) {
      removeItem(dir, id)
    },
    async list() {
      return listItems<Pipeline>(dir)
    },
  }
}

// MARK: - File-backed state store

export function fileStateStore(dir: string): StateStore {
  return {
    async get(pipelineId) {
      return readItem<Record<string, unknown>>(dir, pipelineId)
    },
    async set(pipelineId, stream, data) {
      const state = readItem<Record<string, unknown>>(dir, pipelineId) ?? {}
      state[stream] = data
      writeItem(dir, pipelineId, state)
    },
    async clear(pipelineId) {
      removeItem(dir, pipelineId)
    },
  }
}

// MARK: - File-backed log sink (append NDJSON)

export function fileLogSink(filePath: string): LogSink {
  return {
    write(pipelineId, entry) {
      const dir = join(filePath, '..')
      ensureDir(dir)
      const line = JSON.stringify({ pipelineId, ...entry }) + '\n'
      writeFileSync(filePath, line, { flag: 'a' })
    },
  }
}
