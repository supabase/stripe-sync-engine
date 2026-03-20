# Sync Service Architecture

## Context

The sync engine is a pure function: `runSync(params, source, destination) → AsyncIterable<StateMessage>`. It deliberately ignores four concerns that any real deployment needs: **credentials**, **config**, **state**, and **logs**. The sync service is the stateful layer that manages these concerns and calls the engine.

---

## The Four Concerns

| Concern | Sensitivity | Mutability | Access pattern | Lifetime |
|---|---|---|---|---|
| **Credentials** | High (encrypted, audited) | Rarely — except token refresh | Read on sync start, refresh mid-sync | Outlives syncs (shared across syncs) |
| **Config** | Low (user-editable) | User-initiated only | Read on sync start | Tied to sync definition |
| **State** | None (opaque cursors) | Every checkpoint (~seconds) | Read on resume, write continuously | Tied to sync progress |
| **Logs** | Low | Append-only, never updated | Write continuously, read for debug | Ephemeral (retention-bounded) |

These must be stored separately because they have different:
- **Security requirements** — credentials encrypted at rest + audit-logged; config/state/logs are not
- **Write frequency** — state writes every few seconds; credentials almost never; config only on user action
- **Sharing** — one credential serves many syncs; config/state are per-sync
- **Retention** — logs are pruned; state is cleared on full-refresh; credentials persist until revoked

---

## Stored Form vs Resolved Form

Two distinct shapes exist for a sync:

### SyncConfig (stored form)

What lives in the config store. Has credential **references**, no state:

```ts
type SyncConfig = {
  id: string
  source_credential_id: string        // reference → CredentialStore
  destination_credential_id: string   // reference → CredentialStore
  source: {
    type: string                       // e.g. "stripe"
    [key: string]: unknown             // non-sensitive source config
  }
  destination: {
    type: string                       // e.g. "postgres"
    [key: string]: unknown             // non-sensitive destination config
  }
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
}
```

### SyncParams (resolved form)

What the engine receives. Credentials inlined, state included. This is the existing `SyncParams` type from `packages/sync-protocol/src/protocol.ts`:

```ts
type SyncParams = {
  source?: string                              // connector specifier (default: 'stripe')
  destination: string                          // connector specifier
  source_config: Record<string, unknown>       // credential fields + config merged
  destination_config: Record<string, unknown>  // credential fields + config merged
  streams?: Array<{ name: string; sync_mode?: 'incremental' | 'full_refresh' }>
  state?: Record<string, unknown>
}
```

### Resolution

The service resolves stored → resolved before calling the engine:

```ts
function resolve(opts: {
  config: SyncConfig
  sourceCred: Credential
  destCred: Credential
  state?: Record<string, unknown>
}): SyncParams {
  return {
    source: opts.config.source.type,
    destination: opts.config.destination.type,
    source_config: { ...opts.config.source, ...opts.sourceCred.fields },
    destination_config: { ...opts.config.destination, ...opts.destCred.fields },
    streams: opts.config.streams,
    state: opts.state,
  }
}
```

The engine never sees credential IDs, never knows where config came from, never persists state. It's a pure transformation.

---

## Four Store Interfaces

Each concern gets a minimal generic interface. The sync service depends on these interfaces, not implementations.

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
  type: string                          // "stripe", "postgres", "google"
  fields: Record<string, unknown>       // type-specific fields (api_key, tokens, etc.)
  created_at: string
  updated_at: string
}
```

Implementations: encrypted Postgres table, Vault, env vars (CLI), file (dev).

### ConfigStore

```ts
interface ConfigStore {
  get(id: string): Promise<SyncConfig>
  set(id: string, config: SyncConfig): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<SyncConfig[]>
}
```

Implementations: Postgres table, JSON file (dev).

### StateStore

```ts
interface StateStore {
  get(syncId: string): Promise<Record<string, unknown> | undefined>
  set(syncId: string, stream: string, data: unknown): Promise<void>
  clear(syncId: string): Promise<void>
}
```

Implementations: Postgres `_sync_state` table, destination-embedded, JSON files (dev).

### LogSink

```ts
interface LogSink {
  write(syncId: string, entry: LogEntry): void   // fire-and-forget, non-blocking
}

type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stream?: string
  timestamp: string
}
```

Implementations: stderr (CLI), Postgres table, CloudWatch, file.

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
2. runSync() runs, source paginates normally
3. On page N, source gets 401 → yields ErrorMessage { failure_type: 'auth_error' }
4. Service detects auth_error in the output stream
5. Service refreshes:
   a. refreshToken(cred.fields.refresh_token) → new access_token
   b. credentialStore.set(credId, { ...cred, fields: { ...fields, access_token } })
6. Service re-resolves SyncParams with fresh token
7. Service re-runs runSync() — resumes from last checkpoint (near page N)
```

### Protocol change

The `ErrorMessage.failure_type` enum gains `'auth_error'`:

```ts
// packages/sync-protocol/src/protocol.ts — ErrorMessage
failure_type: z.enum(['config_error', 'system_error', 'transient_error', 'auth_error'])
```

Sources yield `auth_error` on HTTP 401 or equivalent credential failures.

---

## SyncService — The Composition Root

The sync service wires everything together. It's not an abstraction — it's the caller code.

```ts
class SyncService {
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
      const sourceCred = await this.credentials.get(config.source_credential_id)
      const destCred = await this.credentials.get(config.destination_credential_id)

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
          break  // exit pipeline, will retry
        }
        // Persist state checkpoint
        if (msg.type === 'state') {
          await this.states.set(syncId, msg.stream, msg.data)
        }
        yield msg
      }

      if (!authError) return  // success — all streams completed

      // Refresh the failed credential and retry
      await this.refreshCredential(config.source_credential_id)
      retries++
    }

    throw new Error(`Auth failed after ${MAX_AUTH_RETRIES} refresh attempts`)
  }
}
```

The four stores are injected via a named options object — the service doesn't know if they're Postgres, files, or in-memory.

> **Note on `runSync()` vs `createEngine()`**: The service uses `createEngine()` directly (from `packages/sync-protocol/src/engine.ts`). The `runSync()` wrapper in `runSync.ts` is just `yield* createEngine(config, { source, destination }).run()` — a one-liner convenience. The engine is the real interface.

---

## Deployment Configurations

The same `SyncService` class works across all deployment modes by swapping store implementations:

### CLI (stateless)

```ts
const service = new SyncService({
  credentials: envCredentialStore(),          // reads from env vars / flags
  configs:     flagConfigStore(cliFlags),     // builds config from CLI flags
  states:      pgStateStore(postgresUrl),     // reads _sync_state from destination
  logs:        stderrLogSink(),               // logs to stderr
  connectors:  preloadedConnectors({ source, destination }),
})
```

### Local dev (file-backed)

```ts
const service = new SyncService({
  credentials: fileCredentialStore('~/.sync-engine/credentials.json'),
  configs:     fileConfigStore('~/.sync-engine/syncs.json'),
  states:      fileStateStore('~/.sync-engine/state/'),
  logs:        fileLogSink('~/.sync-engine/logs/'),
  connectors:  autoInstallConnectors(),
})
```

### Cloud (Postgres + encrypted)

```ts
const service = new SyncService({
  credentials: pgCredentialStore({ pool, encryptionKey }),   // encrypted at rest
  configs:     pgConfigStore({ pool }),
  states:      pgStateStore({ pool }),
  logs:        kafkaLogSink({ producer: kafkaProducer }),
  connectors:  cachedConnectorResolver(),
})
```

### What doesn't change

The engine (`createEngine`, `runSync`), the source/destination connectors, the `SyncParams` shape, and the `SyncService.run()` method are identical across all deployment modes. Only the four store implementations vary.

---

## How This Relates to Existing Code

### Replaces

- **`apps/control-plane-api/src/store.ts`** — current file store mixes credentials and config in one flat JSON file. Replaced by separate CredentialStore + ConfigStore.
- **`packages/orchestrator-fs`** — FsOrchestrator's `run()` is essentially `SyncService.run()` with file-backed state. The orchestrator interface becomes unnecessary — it's just caller code.
- **`packages/orchestrator-postgres`** — PostgresOrchestrator + PostgresStateManager. The 1000-line state manager covers v1 concerns (sync runs, object runs, task claiming). The v2 StateStore is much simpler — just per-stream cursors.

### Keeps unchanged

- **`packages/sync-protocol`** — `SyncParams`, `runSync()`, `createEngine()`, Source/Destination interfaces. The engine boundary is exactly right.
- **`packages/source-stripe`** — source connector. Receives config with credentials already resolved.
- **`packages/destination-postgres`** — destination connector. No changes needed.
- **`v2-docs/cli-spec.md`** — the CLI spec. The CLI is just a specific wiring of the four stores.

### Evolves

- **`apps/control-plane-api`** — currently does CRUD for credentials and syncs in one store. Should be refactored to use separate CredentialStore + ConfigStore interfaces. The API routes stay the same.

---

## Key Files

| File | Role |
|---|---|
| `packages/sync-protocol/src/protocol.ts` | `SyncParams` (resolved form), `ErrorMessage` (needs `auth_error`), Source/Destination interfaces |
| `packages/sync-protocol/src/engine.ts` | `createEngine()` — the engine factory the service calls |
| `packages/sync-protocol/src/runSync.ts` | `runSync()` — convenience wrapper over `createEngine().run()` |
| `apps/control-plane-api/src/store.ts` | Current file store — to be replaced by separate stores |
| `apps/control-plane-api/src/schemas.ts` | Credential/sync schemas (SyncConfig stored form) |
