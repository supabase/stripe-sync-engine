import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Pipeline } from './createSchemas.js'
import type { PipelineStore } from './stores.js'

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
    async update(id, patch) {
      const existing = readItem<Pipeline>(dir, id)
      if (!existing) throw new Error(`Pipeline not found: ${id}`)
      const updated = { ...existing, ...patch, id }
      writeItem(dir, id, updated)
      return updated
    },
    async delete(id) {
      removeItem(dir, id)
    },
    async list() {
      return listItems<Pipeline>(dir)
    },
  }
}
