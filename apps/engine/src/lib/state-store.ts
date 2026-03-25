// MARK: - Interface

/** Pipeline-scoped state store — load prior state and persist checkpoints. */
export interface StateStore {
  get(): Promise<Record<string, unknown> | undefined>
  set(stream: string, data: unknown): Promise<void>
}

// MARK: - No-op state store (explicit opt-out of persistence)

/** A StateStore that discards all writes and returns no stored state. */
export function noopStateStore(): StateStore {
  return {
    async get() {
      return undefined
    },
    async set() {},
  }
}
