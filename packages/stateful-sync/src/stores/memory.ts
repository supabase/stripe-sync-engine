import type {
  Credential,
  CredentialStore,
  SyncConfig,
  ConfigStore,
  StateStore,
  LogSink,
  LogEntry,
} from '../stores.js'

// MARK: - In-memory credential store

export function memoryCredentialStore(initial?: Record<string, Credential>): CredentialStore {
  const store = new Map<string, Credential>(initial ? Object.entries(initial) : [])

  return {
    async get(id) {
      const cred = store.get(id)
      if (!cred) throw new Error(`Credential not found: ${id}`)
      return cred
    },
    async set(id, credential) {
      store.set(id, credential)
    },
    async delete(id) {
      store.delete(id)
    },
    async list() {
      return [...store.values()]
    },
  }
}

// MARK: - In-memory config store

export function memoryConfigStore(initial?: Record<string, SyncConfig>): ConfigStore {
  const store = new Map<string, SyncConfig>(initial ? Object.entries(initial) : [])

  return {
    async get(id) {
      const config = store.get(id)
      if (!config) throw new Error(`SyncConfig not found: ${id}`)
      return config
    },
    async set(id, config) {
      store.set(id, config)
    },
    async delete(id) {
      store.delete(id)
    },
    async list() {
      return [...store.values()]
    },
  }
}

// MARK: - In-memory state store

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

// MARK: - In-memory log sink (collects entries for testing)

export function memoryLogSink(): LogSink & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    write(_syncId, entry) {
      entries.push(entry)
    },
  }
}
