import type { SyncState } from '@stripe/sync-protocol'

// MARK: - Interface

/** Pipeline-scoped state store — load prior state and persist checkpoints. */
export interface StateStore {
  get(): Promise<SyncState | undefined>
  set(stream: string, data: unknown): Promise<void>
  setGlobal(data: unknown): Promise<void>
}

// MARK: - Read-only state store

/**
 * A StateStore that returns the provided initial state (if any) and discards all writes.
 * Use when the caller manages state externally (e.g., via HTTP headers or workflow state).
 */
export function readonlyStateStore(state?: SyncState): StateStore {
  return {
    async get() {
      return state
    },
    async set() {},
    async setGlobal() {},
  }
}
