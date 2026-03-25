// MARK: - Interface

/** Pipeline-scoped state writer — the only state interface the sync engine needs. */
export interface StateStore {
  set(stream: string, data: unknown): Promise<void>
}

// MARK: - No-op state store (explicit opt-out of persistence)

/** A StateStore that discards all writes. */
export function noopStateStore(): StateStore {
  return {
    async set() {},
  }
}
