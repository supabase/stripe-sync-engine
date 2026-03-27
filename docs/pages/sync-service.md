# Sync Service Architecture

## Context

The sync engine is a pure function: `createEngine(params, { source, destination })`. It deliberately ignores four concerns that any real deployment needs: **credentials**, **config**, **state**, and **logs**. The sync service (`StatefulSync` in `packages/stateful-sync`) is the stateful layer that manages these concerns and calls the engine.

---

## The Four Concerns

| Concern         | Sensitivity               | Mutability                    | Access pattern                       | Lifetime                             |
| --------------- | ------------------------- | ----------------------------- | ------------------------------------ | ------------------------------------ |
| **Credentials** | High (encrypted, audited) | Rarely — except token refresh | Read on sync start, refresh mid-sync | Outlives syncs (shared across syncs) |
| **Config**      | Low (user-editable)       | User-initiated only           | Read on sync start                   | Tied to sync definition              |
| **State**       | None (opaque cursors)     | Every checkpoint (~seconds)   | Read on resume, write continuously   | Tied to sync progress                |
| **Logs**        | Low                       | Append-only, never updated    | Write continuously, read for debug   | Ephemeral (retention-bounded)        |

These must be stored separately because they have different:

- **Security requirements** — credentials encrypted at rest + audit-logged; config/state/logs are not
- **Write frequency** — state writes every few seconds; credentials almost never; config only on user action
- **Sharing** — one credential serves many syncs; config/state are per-sync
- **Retention** — logs are pruned; state is cleared on full-refresh; credentials persist until revoked

---

## Stored Form vs Resolved Form

Two distinct shapes exist for a sync:

### SyncConfig (stored form)

What lives in the config store. Has credential **references**, no embedded state:

```ts
type SyncConfig = {
  id: string
  source: {
    type: string // e.g. "stripe"
    credential_id?: string // reference → CredentialStore
    [key: string]: unknown // non-sensitive source config
  }
  destination: {
    type: string // e.g. "postgres"
    credential_id?: string // reference → CredentialStore
    [key: string]: unknown // non-sensitive destination config
  }
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
}
```

### SyncParams (resolved form)

What the engine receives. Credentials inlined, state passed separately. This is the `SyncParams` type from `@stripe/sync-engine`:

```ts
type SyncParams = {
  source: { name: string; [key: string]: unknown } // name + credential fields + config merged
  destination: { name: string; [key: string]: unknown } // name + credential fields + config merged
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}
```

### Resolution

The service resolves stored → resolved before calling the engine:

```ts
function resolve(opts: {
  config: SyncConfig
  sourceCred?: Credential
  destCred?: Credential
  state?: Record<string, unknown>
}): SyncParams {
  return {
    source: { name: opts.config.source.type, ...opts.config.source, ...opts.sourceCred?.fields },
    destination: { name: opts.config.destination.type, ...opts.config.destination, ...opts.destCred?.fields },
    streams: opts.config.streams,
    state: opts.state,
  }
}
```

The engine never sees credential IDs, never knows where config came from, never persists state. It's a pure transformation.

---

## Four Store Interfaces

Each concern gets a minimal generic interface. `StatefulSync` depends on these interfaces, not implementations.

### CredentialStore

```ts
interface CredentialStore {
  get(id: string): Promise<Credential>
  set(id: string, credential: Credential): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<Credential[]>
}

type Credential = {
  id: string
  type: string // "stripe", "postgres", "google"
  fields: Record<string, unknown> // type-specific fields (api_key, tokens, etc.)
  created_at: string
  updated_at: string
}
```

Implementations: file-backed JSON (dev/CLI), encrypted Postgres table (cloud), Vault.

### ConfigStore

```ts
interface ConfigStore {
  get(id: string): Promise<SyncConfig>
  set(id: string, config: SyncConfig): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<SyncConfig[]>
}
```

Implementations: file-backed JSON (dev/CLI), Postgres table (cloud).

### StateStore

```ts
interface StateStore {
  get(syncId: string): Promise<Record<string, unknown> | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
}
```

Implementations: file-backed JSON (dev/CLI), Postgres `_sync_state` table (cloud).

### LogSink

```ts
interface LogSink {
  write(syncId: string, entry: LogEntry): void // fire-and-forget, non-blocking
}

type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stream?: string
  timestamp: string
}
```

Implementations: stderr (CLI), NDJSON file (dev), Postgres table (cloud).

---

## Credential Refresh (Service-Level Retry)

Token refresh is handled by the **service**, not the source. The source interface stays pure — `read(params)` with a plain config object, no credential providers or functions.

### Why service-level, not per-request

An alternative is injecting a `credentialProvider` into the source for per-request refresh (zero wasted work on 401). This was rejected because it changes the Source interface. The coarse retry tradeoff is acceptable:

- Stripe API keys don't expire (most common case — refresh never triggers)
- OAuth tokens have ~1-hour lifetimes — a single retry handles it
- State is checkpointed, so re-runs resume near where they left off
- Upserts are idempotent — re-fetching a few pages causes no data corruption

### How it works

```
1. Service resolves credentials → SyncParams (access_token inlined)
2. engine.run() runs, source paginates normally
3. On page N, source gets 401 → yields ErrorMessage { failure_type: 'auth_error' }
4. Service detects auth_error in the output stream
5. Service refreshes:
   a. refreshToken(cred.fields.refresh_token) → new access_token
   b. credentialStore.set(credId, { ...cred, fields: { ...fields, access_token } })
6. Service re-resolves SyncParams with fresh token
7. Service re-runs engine — resumes from last checkpoint (near page N)
```

### Protocol change

The `ErrorMessage.failure_type` enum includes `'auth_error'`:

```ts
// packages/protocol/src/protocol.ts — ErrorMessage
failure_type: z.enum(['config_error', 'system_error', 'transient_error', 'auth_error'])
```

Sources yield `auth_error` on HTTP 401 or equivalent credential failures.

---

## StatefulSync — The Composition Root

`StatefulSync` wires everything together. It's not an abstraction — it's the caller code.

```ts
class StatefulSync {
  private credentials: CredentialStore
  private configs: ConfigStore
  private states: StateStore
  private logs: LogSink
  private connectors: ConnectorResolver

  constructor(opts: {
    credentials: CredentialStore
    configs: ConfigStore
    states: StateStore
    logs: LogSink
    connectors: ConnectorResolver
  }) {
    Object.assign(this, opts)
  }

  async *run(syncId: string): AsyncIterable<StateMessage> {
    const config = await this.configs.get(syncId)
    const source = await this.connectors.loadSource(config.source.type)
    const destination = await this.connectors.loadDestination(config.destination.type)

    let retries = 0
    const MAX_AUTH_RETRIES = 2

    while (retries <= MAX_AUTH_RETRIES) {
      // Load credentials (fresh on each attempt — may have been refreshed)
      const sourceCred = config.source.credential_id
        ? await this.credentials.get(config.source.credential_id)
        : undefined
      const destCred = config.destination.credential_id
        ? await this.credentials.get(config.destination.credential_id)
        : undefined

      // Load state (picks up checkpoints from previous attempt)
      const state = await this.states.get(syncId)

      // Resolve to SyncParams
      const params = resolve({ config, sourceCred, destCred, state })

      // Create engine and run
      const engine = createEngine(params, { source, destination })

      let authError = false

      for await (const msg of engine.run()) {
        if (msg.type === 'error' && msg.failure_type === 'auth_error') {
          authError = true
          break // exit pipeline, will retry
        }
        // Persist state checkpoint
        if (msg.type === 'state') {
          await this.states.set(syncId, msg.stream, msg.data)
        }
        yield msg
      }

      if (!authError) return // success — all streams completed

      // Refresh the failed credential and retry
      await this.refreshCredential(config.source.credential_id!)
      retries++
    }

    throw new Error(`Auth failed after ${MAX_AUTH_RETRIES} refresh attempts`)
  }
}
```

The four stores are injected via a named options object — the service doesn't know if they're Postgres, files, or in-memory.

> **Note on `createEngine()`**: `StatefulSync` uses `createEngine()` directly (from `@stripe/sync-engine`). The engine is the real interface — `StatefulSync` adds only the store-loading and state-persistence wrapper around it.

---

## Deployment Configurations

The same `StatefulSync` class works across all deployment modes by swapping store implementations. Both CLI and API use 4 file-based stores under `--data-dir` / `DATA_DIR` / `~/.stripe-sync`:

### Local dev / CLI / API (file-backed)

```ts
const service = new StatefulSync({
  credentials: fileCredentialStore(path.join(dataDir, 'credentials.json')),
  configs: fileConfigStore(path.join(dataDir, 'syncs.json')),
  states: fileStateStore(path.join(dataDir, 'state.json')),
  logs: fileLogSink(path.join(dataDir, 'logs.ndjson')),
  connectors: createConnectorResolver(),
})
```

### Cloud (Postgres + encrypted)

```ts
const service = new StatefulSync({
  credentials: pgCredentialStore({ pool, encryptionKey }), // encrypted at rest
  configs: pgConfigStore({ pool }),
  states: pgStateStore({ pool }),
  logs: pgLogSink({ pool }),
  connectors: cachedConnectorResolver(),
})
```

### What doesn't change

The engine (`createEngine`), the source/destination connectors, the `SyncParams` shape, and the `StatefulSync.run()` method are identical across all deployment modes. Only the four store implementations vary.

---

## Key Files

| File                                    | Role                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/protocol/src/protocol.ts`     | `Source`/`Destination` interfaces, `ErrorMessage` (with `auth_error`), message types |
| `packages/stateless-sync/src/engine.ts` | `createEngine()` — the engine factory the service calls                              |
| `packages/stateful-sync/src/service.ts` | `StatefulSync` class, `resolve()` function                                           |
| `packages/stateful-sync/src/stores.ts`  | Store interfaces: `CredentialStore`, `ConfigStore`, `StateStore`, `LogSink`          |
| `apps/stateful/src/cli/index.ts`        | Stateful CLI entrypoint (wires file stores + StatefulSync)                           |
| `apps/stateful/src/api/app.ts`          | Stateful HTTP API (CRUD + SSE sync execution)                                        |
