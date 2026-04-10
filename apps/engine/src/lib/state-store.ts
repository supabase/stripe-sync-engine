import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SourceState } from '@stripe/sync-protocol'

// MARK: - Interface

/** Pipeline-scoped state store — load prior state and persist checkpoints. */
export interface StateStore {
  get(): Promise<SourceState | undefined>
  set(stream: string, data: unknown): Promise<void>
  setGlobal(data: unknown): Promise<void>
}

// MARK: - Read-only state store

/**
 * A StateStore that returns the provided initial state (if any) and discards all writes.
 * Use when the caller manages state externally (e.g., via HTTP headers or workflow state).
 */
export function readonlyStateStore(state?: SourceState): StateStore {
  return {
    async get() {
      return state
    },
    async set() {},
    async setGlobal() {},
  }
}

// MARK: - File state store

/**
 * A StateStore backed by a JSON file on disk.
 * Reads/writes the full state on every operation — simple and sufficient for CLI usage.
 */
export function fileStateStore(filePath: string): StateStore {
  function read(): SourceState {
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as SourceState
    } catch {
      return { streams: {}, global: {} }
    }
  }

  function write(state: SourceState): void {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, JSON.stringify(state, null, 2) + '\n')
  }

  return {
    async get() {
      const s = read()
      return Object.keys(s.streams).length > 0 || Object.keys(s.global ?? {}).length > 0
        ? s
        : undefined
    },
    async set(stream, data) {
      const s = read()
      s.streams[stream] = data
      write(s)
    },
    async setGlobal(data) {
      const s = read()
      s.global = data as Record<string, unknown>
      write(s)
    },
  }
}
