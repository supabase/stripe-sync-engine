# Writing Connectors

This guide covers how to implement a new source or destination using `@stripe/sync-protocol`.

## Structure

A connector is a single package that exports:

1. **`spec`** — a Zod schema defining the connector's configuration
2. **`Config`** — the inferred TypeScript type (`z.infer<typeof spec>`)
3. **default export** — an object literal with `satisfies Source<Config>` or `satisfies Destination<Config>`

```
packages/source-example/
  src/
    index.ts      # spec + default export
  package.json    # depends on @stripe/sync-protocol
```

## Rules

### Config spec

- Define config as a `z.object({...})` and export it as `spec`
- All field names use **snake_case** (e.g. `api_key`, `connection_string`)
- `spec()` returns `{ config: z.toJSONSchema(spec) }`
- Export the inferred type: `export type Config = z.infer<typeof spec>`
- Config is for **connection details only** — stream selection belongs on `ConfiguredCatalog`

### satisfies pattern

Use `satisfies` on the object literal, not on the export. This lets the compiler:

- **Check** that the object conforms to `Source<Config>` or `Destination<Config>`
- **Infer** parameter types from the interface (no need to annotate params)
- **Preserve** the narrow return types (the export keeps the inferred type, not the wide interface type)

```ts
// Good — satisfies on the literal, compiler infers param types
const source = {
  spec() { ... },
  async check({ config }) { ... },
  async discover({ config }) { ... },
  async *read({ config, catalog, state }) { ... },
} satisfies Source<Config>

export default source

// Bad — explicit type annotation widens return types
const source: Source<Config> = { ... }
```

### Named params

All methods (except `spec()`) take a single params object with named fields.
Destructure in the method signature:

```ts
async check({ config }) { ... }
async discover({ config }) { ... }
async *read({ config, catalog, state }) { ... }
async *write({ config, catalog }, $stdin) { ... }
```

This maps directly to the CLI's `--key value` flags:

```sh
source-stripe check   --config '{"api_key":"sk_test_..."}'
source-stripe read    --config '...' --catalog '...' --state '...'
dest-postgres  write  --config '...' --catalog '...'   # messages from stdin
```

### String literals

When returning objects with union-typed fields (`status`, `type`), use `as const` so
the literal type is preserved:

```ts
return { status: 'succeeded' as const }
return { type: 'catalog' as const, streams: [...] }
```

## Source interface

```ts
interface Source<TConfig, TStreamState = unknown, TInput = unknown> {
  spec(): ConnectorSpecification
  check(params: { config: TConfig }): Promise<CheckResult>
  discover(params: { config: TConfig }): Promise<CatalogMessage>
  read(
    params: {
      config: TConfig
      catalog: ConfiguredCatalog
      state?: Record<string, TStreamState>
    },
    $stdin?: AsyncIterable<TInput>
  ): AsyncIterable<Message>
}
```

| Method                              | Purpose                                                                                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec()`                            | Return JSON Schema for the config. No params — called before config exists.                                                                                          |
| `check({ config })`                 | Test connectivity. Return `{ status: 'succeeded' }` or `{ status: 'failed', message }`.                                                                              |
| `discover({ config })`              | Return a `CatalogMessage` listing available streams with their schemas and primary keys.                                                                             |
| `read({ config, catalog, state? })` | Yield messages for the configured streams. `catalog` is `ConfiguredCatalog` (user's selection + sync modes). `state` is the previous checkpoint for resumable syncs. |

### read() messages

A source yields these message types:

- **`RecordMessage`** — one data record for a stream. Use `toRecordMessage(stream, data)`.
- **`StateMessage`** — per-stream checkpoint. Opaque to the orchestrator; only the source reads/writes the `data` field.
- **`StreamStatusMessage`** — progress updates (`started`, `running`, `complete`, `incomplete`).
- **`LogMessage`** / **`ErrorMessage`** — diagnostics.

### read() lifecycle

```
for each configured stream:
  yield stream_status: started
  paginate through data:
    yield record messages
    yield state checkpoint after each page
  yield stream_status: complete
```

## Destination interface

```ts
interface Destination<TConfig> {
  spec(): ConnectorSpecification
  check(params: { config: TConfig }): Promise<CheckResult>
  write(
    params: { config: TConfig; catalog: ConfiguredCatalog },
    $stdin: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput>
}
```

| Method                               | Purpose                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `spec()`                             | Return JSON Schema for the config.                                                                                           |
| `check({ config })`                  | Test connectivity (e.g. `SELECT 1`).                                                                                         |
| `write({ config, catalog }, $stdin)` | Consume `DestinationInput` messages, write records, yield `DestinationOutput`. `$stdin` comes from stdin when piped via CLI. |

### write() messages

Input (`DestinationInput`):

- **`RecordMessage`** — upsert this record
- **`StateMessage`** — passthrough; yield it back after committing the batch

Output (`DestinationOutput`):

- **`StateMessage`** — re-yield after commit so the orchestrator can checkpoint
- **`ErrorMessage`** — write failures
- **`LogMessage`** — diagnostics

### ConfiguredCatalog in write()

The destination receives `ConfiguredCatalog`, not raw `CatalogMessage`. Access stream
info via `catalog.streams[i].stream.name` and `catalog.streams[i].stream.primary_key`.

## Data model

### Stream vs ConfiguredStream

- **`Stream`** — discovered by `discover()`. Describes what's available: name, primary key, JSON schema, metadata.
- **`ConfiguredStream`** — user's selection. Wraps a `Stream` with `sync_mode`, `destination_sync_mode`, and optional `cursor_field`.
- **`ConfiguredCatalog`** — `{ streams: ConfiguredStream[] }`. Persisted on the Sync resource. Passed to `read()` and `write()`.

`discover()` returns streams (ephemeral). The user picks and configures them. The
`ConfiguredCatalog` is what gets stored and used at sync time.

## Minimal source example

```ts
import { z } from 'zod'
import type { Source } from '@stripe/sync-protocol'
import { toRecordMessage } from '@stripe/sync-protocol'

export const spec = z.object({
  api_key: z.string().describe('API key'),
  base_url: z.string().url().optional().describe('API base URL override'),
})

export type Config = z.infer<typeof spec>

const source = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    // test connectivity
    return { status: 'succeeded' as const }
  },

  async discover({ config }) {
    return {
      type: 'catalog' as const,
      streams: [{ name: 'widgets', primary_key: [['id']] }],
    }
  },

  async *read({ config, catalog, state }) {
    for (const cs of catalog.streams) {
      yield { type: 'stream_status', stream: cs.stream.name, status: 'started' }
      // ... fetch and yield records ...
      yield { type: 'stream_status', stream: cs.stream.name, status: 'complete' }
    }
  },
} satisfies Source<Config>

export default source
```

## Minimal destination example

```ts
import { z } from 'zod'
import type { Destination } from '@stripe/sync-protocol'

export const spec = z.object({
  url: z.string().describe('Connection string'),
})

export type Config = z.infer<typeof spec>

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    // test connectivity
    return { status: 'succeeded' as const }
  },

  async *write({ config, catalog }, $stdin) {
    for await (const msg of $stdin) {
      if (msg.type === 'state') {
        yield msg // passthrough after commit
        continue
      }
      // msg.type === 'record' — write to downstream system
    }
  },
} satisfies Destination<Config>

export default destination
```

## CLI usage

The `ts-cli` bridge maps `--key value` flags to the named params object:

```sh
# spec (no params)
source-stripe spec

# check / discover (just --config)
source-stripe check   --config '{"api_key":"sk_test_..."}'
source-stripe discover --config '{"api_key":"sk_test_..."}'

# read (--config + --catalog, optional --state)
source-stripe read \
  --config '{"api_key":"sk_test_...","base_url":"http://localhost:12111"}' \
  --catalog '{"streams":[{"stream":{"name":"customer","primary_key":[["id"]]},"sync_mode":"full_refresh","destination_sync_mode":"append"}]}'

# write (--config + --catalog, messages from stdin pipe)
source-stripe read --config '...' --catalog '...' \
  | dest-postgres write --config '{"url":"postgres://..."}' --catalog '...'
```
