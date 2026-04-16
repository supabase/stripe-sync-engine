# Protocol Comparison: Sync Engine vs Airbyte

Message-by-message comparison of our protocol (`packages/protocol`) against the
[Airbyte Protocol](https://docs.airbyte.com/understanding-airbyte/airbyte-protocol)
(v0.5.0). Both use an NDJSON wire format with a `type` discriminator per message.

## Message Type Map

| Airbyte type        | Sync Engine type    | Status     |
| ------------------- | ------------------- | ---------- |
| `RECORD`            | `record`            | Equivalent |
| `STATE`             | `state`             | Simplified |
| `CATALOG`           | `catalog`           | Equivalent |
| `LOG`               | `log`               | Equivalent |
| `SPEC`              | `spec`              | Simplified |
| `CONNECTION_STATUS` | `connection_status` | Equivalent |
| `TRACE`             | `trace`             | Reduced    |
| `CONTROL`           | `control`           | Equivalent |
| —                   | `eof`               | **New**    |

## Message-by-Message Detail

### RECORD

| Field        | Airbyte                  | Sync Engine                  | Notes                                                           |
| ------------ | ------------------------ | ---------------------------- | --------------------------------------------------------------- |
| `stream`     | `string`                 | `string`                     | Same                                                            |
| `namespace`  | `string` (optional)      | —                            | We encode namespace in the stream name (e.g. `pg_public.users`) |
| `data`       | `object`                 | `Record<string, unknown>`    | Same                                                            |
| `emitted_at` | `integer` (epoch millis) | `string` (ISO 8601 datetime) | We use ISO strings instead of epoch millis                      |

### STATE

| Field        | Airbyte                           | Sync Engine                       | Notes                                                        |
| ------------ | --------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| `state_type` | `enum(LEGACY, STREAM, GLOBAL)`    | `enum('stream', 'global')`        | We skip LEGACY; old messages default to `stream` via Zod     |
| `stream`     | `AirbyteStreamState` object       | `string` (stream name)            | Only present on `stream`-type messages                       |
| `global`     | `AirbyteGlobalState` object       | `GlobalStatePayload`              | Sync-wide cursor (e.g. `events_cursor`)                      |
| `data`       | `object` (deprecated legacy blob) | `unknown` (per-stream checkpoint) | Our `data` is the per-stream checkpoint, not the legacy blob |

**Key difference:** Airbyte supports three state modes (legacy, per-stream, global).
We skip LEGACY and support both STREAM and GLOBAL via a `state_type` discriminated
union. Old messages without `state_type` are backward-compatibly parsed as `stream`
type. The `SyncState` aggregate shape (`{ streams, global }`) replaces the flat
`Record<string, unknown>` used previously.

### CATALOG

| Field     | Airbyte           | Sync Engine | Notes                       |
| --------- | ----------------- | ----------- | --------------------------- |
| `streams` | `AirbyteStream[]` | `Stream[]`  | See stream comparison below |

**AirbyteStream vs Stream:**

| Field                   | Airbyte             | Sync Engine                     | Notes                                                             |
| ----------------------- | ------------------- | ------------------------------- | ----------------------------------------------------------------- |
| `name`                  | `string`            | `string`                        | Same                                                              |
| `namespace`             | `string` (optional) | —                               | Encoded in stream name                                            |
| `json_schema`           | `object`            | `Record<string, unknown>` (opt) | Optional in ours                                                  |
| `primary_key`           | `string[][]`        | `string[][]`                    | Same                                                              |
| `source_defined_cursor` | `boolean`           | —                               | We don't distinguish source- vs user-defined cursors              |
| `default_cursor_field`  | `string[]`          | —                               | Cursor is on ConfiguredStream                                     |
| `supported_sync_modes`  | `enum[]`            | —                               | We declare sync_mode on ConfiguredStream, not capabilities        |
| `metadata`              | —                   | `Record<string, unknown>` (opt) | **New.** Source-specific metadata (api_version, account_id, etc.) |

### LOG

| Field         | Airbyte                                        | Sync Engine                      | Notes                                     |
| ------------- | ---------------------------------------------- | -------------------------------- | ----------------------------------------- |
| `level`       | `enum(FATAL, ERROR, WARN, INFO, DEBUG, TRACE)` | `enum(error, warn, info, debug)` | We omit FATAL and TRACE levels            |
| `message`     | `string`                                       | `string`                         | Same                                      |
| `stack_trace` | `string` (optional)                            | —                                | We put stack traces in TraceError instead |

### SPEC

| Field                              | Airbyte                | Sync Engine                          | Notes                                                      |
| ---------------------------------- | ---------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `connectionSpecification`          | `object` (JSON Schema) | `config` (`Record<string, unknown>`) | Same concept, different field name                         |
| `protocol_version`                 | `string`               | —                                    | We don't version the protocol yet                          |
| `supported_destination_sync_modes` | `enum[]`               | —                                    | Not needed; we declare modes on ConfiguredStream           |
| `documentationUrl`                 | `string`               | —                                    | Not needed                                                 |
| `changelogUrl`                     | `string`               | —                                    | Not needed                                                 |
| `stream_state`                     | —                      | `Record<string, unknown>` (opt)      | **New.** JSON Schema for per-stream state shape            |
| `input`                            | —                      | `Record<string, unknown>` (opt)      | **New.** JSON Schema for read() input (e.g. webhook event) |

### CONNECTION_STATUS

| Field     | Airbyte                   | Sync Engine               | Notes           |
| --------- | ------------------------- | ------------------------- | --------------- |
| `status`  | `enum(SUCCEEDED, FAILED)` | `enum(succeeded, failed)` | Same, lowercase |
| `message` | `string` (optional)       | `string` (optional)       | Same            |

### TRACE

Airbyte uses `type` as the subtype discriminator; we use `trace_type`.

| Subtype         | Airbyte                           | Sync Engine         | Notes                          |
| --------------- | --------------------------------- | ------------------- | ------------------------------ |
| `error`         | `AirbyteErrorTraceMessage`        | `TraceError`        | See below                      |
| `estimate`      | `AirbyteEstimateTraceMessage`     | `TraceEstimate`     | See below                      |
| `stream_status` | `AirbyteStreamStatusTraceMessage` | `TraceStreamStatus` | See below                      |
| `analytics`     | `AirbyteAnalyticsTraceMessage`    | —                   | We don't have analytics traces |

All Airbyte trace messages include an `emitted_at` timestamp; ours do not.

**TraceError vs AirbyteErrorTraceMessage:**

| Field              | Airbyte                            | Sync Engine                                                     | Notes                                     |
| ------------------ | ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| `message`          | `string`                           | `string`                                                        | Same                                      |
| `internal_message` | `string` (optional)                | —                                                               | We don't split user/internal messages     |
| `stack_trace`      | `string` (optional)                | `string` (optional)                                             | Same                                      |
| `failure_type`     | `enum(system_error, config_error)` | `enum(config_error, system_error, transient_error, auth_error)` | We add `transient_error` and `auth_error` |
| `stream`           | —                                  | `string` (optional)                                             | **New.** Which stream triggered the error |

**TraceEstimate vs AirbyteEstimateTraceMessage:**

| Field                        | Airbyte                     | Sync Engine                   | Notes                       |
| ---------------------------- | --------------------------- | ----------------------------- | --------------------------- |
| `name`/`stream`              | `name` (`string`)           | `stream` (`string`)           | Different field name        |
| `type`                       | `enum(STREAM, SYNC)`        | —                             | We only estimate per-stream |
| `namespace`                  | `string` (optional)         | —                             | Encoded in stream name      |
| `row_estimate`/`row_count`   | `row_estimate` (`integer`)  | `row_count` (`integer`, opt)  | Different field name        |
| `byte_estimate`/`byte_count` | `byte_estimate` (`integer`) | `byte_count` (`integer`, opt) | Different field name        |

**TraceStreamStatus vs AirbyteStreamStatusTraceMessage:**

| Field    | Airbyte                                                      | Sync Engine                                    | Notes                  |
| -------- | ------------------------------------------------------------ | ---------------------------------------------- | ---------------------- |
| `stream` | `StreamDescriptor` (name + namespace)                        | `string` (stream name)                         | We use plain string    |
| `status` | `enum(STARTED, RUNNING, COMPLETE, INCOMPLETE, RATE_LIMITED)` | `enum(started, running, complete, incomplete)` | We omit `rate_limited` |

### CONTROL

Both protocols use control messages for **connector-to-orchestrator** communication —
the connector tells the orchestrator "update my persisted config with these fields."
The canonical use case is OAuth token refresh: a source discovers its token has rotated
and emits a control message so the orchestrator persists the new token before the next run.

**Envelope comparison:**

| Field         | Airbyte                           | Sync Engine                                 | Notes                                        |
| ------------- | --------------------------------- | ------------------------------------------- | -------------------------------------------- |
| discriminator | `type` (on AirbyteMessage)        | `type: 'control'` (on Message)              | Same pattern                                 |
| subtype field | `type` (on AirbyteControlMessage) | `control_type`                              | Airbyte reuses `type` at both levels         |
| `emitted_at`  | `number` (epoch millis, required) | `_ts` on `MessageBase` (ISO 8601, optional) | We timestamp all messages, not just controls |

**Subtypes:**

| Airbyte subtype    | Sync Engine subtype | Notes   |
| ------------------ | ------------------- | ------- |
| `CONNECTOR_CONFIG` | `connector_config`  | Aligned |

Airbyte only documents one subtype (`CONNECTOR_CONFIG`). We have one (`connector_config`).

**Payload comparison (CONNECTOR_CONFIG vs connector_config):**

| Field    | Airbyte                                          | Sync Engine                                                     | Notes                              |
| -------- | ------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| `config` | nested under `connectorConfig.config` (`object`) | directly on `ControlPayload.config` (`Record<string, unknown>`) | Airbyte has an extra nesting level |

**Replacement semantics:** In both protocols, the connector emits the **full updated config**
and the orchestrator replaces the stored config wholesale — no shallow merging. The engine validates the result against the connector's spec schema before returning

**When control messages can be emitted:**

| Context      | Airbyte                                    | Sync Engine                                                               |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| `read()`     | Yes — connectors can emit CONTROL mid-read | Yes — `pipeline_sync` splits source signals and yields them to the caller |
| `setup()`    | N/A (no setup command)                     | Yes — primary place we collect them via `collectControls()`               |
| `check()`    | Not documented                             | Not in the output type                                                    |
| `discover()` | Not documented                             | Not in the output type                                                    |
| `write()`    | Not documented                             | Not in the output type (`DestinationOutput` excludes it)                  |

**How each layer handles control messages:**

```
Airbyte:
  connector.read() emits CONTROL with full updated config
    → platform intercepts → replaces stored config → persists to DB

Sync Engine:
  connector.setup() emits ControlMessage with full updated config
    → engine.pipeline_setup() yields ControlMessage in SetupOutput stream
    → service setup activity replaces config in pipeline store

  connector.read() emits ControlMessage with full updated config
    → engine.pipeline_sync() splits read stream via split()
    → source signals (control, trace, log) tagged with _emitted_by, _ts
    → merged with destination output via merge()
    → yielded as SyncOutput stream
    → service drainMessages() captures last control config
    → service syncImmediate activity replaces config in pipeline store
```

**User-initiated config changes (service only):**

Separately from the protocol's connector-initiated control messages, the service has
a completely different path for user-initiated config changes via `PATCH /pipelines/:id`:

1. API writes new config directly to the pipeline store
2. Sends a best-effort Temporal signal (`'update'` with `{}`) to wake the workflow
3. The signal carries **no config data** — the workflow just re-reads from the store
   on the next activity execution

This is invisible to the protocol layer — it's purely a service concern.

### EOF (Sync Engine only)

| Field    | Sync Engine                                      | Notes                |
| -------- | ------------------------------------------------ | -------------------- |
| `reason` | `enum(complete, state_limit, time_limit, error)` | Why the stream ended |

Airbyte has no equivalent — stream termination is implicit (process exit) or expressed
via `stream_status: COMPLETE/INCOMPLETE` trace messages. Our `eof` message makes
termination reason explicit and machine-readable without needing to inspect traces.

## Per-Command Output Types

| Command      | Airbyte output                     | Sync Engine output                                         |
| ------------ | ---------------------------------- | ---------------------------------------------------------- |
| `spec()`     | SPEC, LOG                          | `SpecMessage \| LogMessage \| TraceMessage`                |
| `check()`    | CONNECTION_STATUS, LOG             | `ConnectionStatusMessage \| LogMessage \| TraceMessage`    |
| `discover()` | CATALOG, LOG                       | `CatalogMessage \| LogMessage \| TraceMessage`             |
| `read()`     | RECORD, STATE, LOG, TRACE, CONTROL | `Message` (all types)                                      |
| `write()`    | STATE, LOG, TRACE                  | `StateMessage \| TraceMessage \| LogMessage \| EofMessage` |
| `setup()`    | —                                  | `ControlMessage \| LogMessage \| TraceMessage`             |
| `teardown()` | —                                  | `LogMessage \| TraceMessage`                               |

Airbyte has no `setup()`/`teardown()` commands — resource provisioning is handled
outside the connector protocol.

## Configured Catalog Comparison

| Field                   | Airbyte                                 | Sync Engine                             | Notes                                  |
| ----------------------- | --------------------------------------- | --------------------------------------- | -------------------------------------- |
| `sync_mode`             | `enum(full_refresh, incremental)`       | `enum(full_refresh, incremental)`       | Same                                   |
| `destination_sync_mode` | `enum(append, overwrite, append_dedup)` | `enum(append, overwrite, append_dedup)` | Same                                   |
| `cursor_field`          | `string[]`                              | `string[]` (optional)                   | Same                                   |
| `primary_key`           | `string[][]`                            | — (on Stream, not ConfiguredStream)     | We put PK on the stream itself         |
| `fields`                | —                                       | `string[]` (optional)                   | **New.** Field selection               |
| `backfill_limit`        | —                                       | `number` (optional)                     | **New.** Cap backfill records          |
| `system_columns`        | —                                       | `object[]` (optional)                   | **New.** Extra columns for destination |

## Summary of Divergences

1. **No namespace** — we encode it in the stream name.
2. **No legacy state** — we support `stream` and `global` modes but skip `LEGACY`.
3. **ISO timestamps** — records use ISO 8601 strings, not epoch millis.
4. **Richer failure types** — `transient_error` and `auth_error` added.
5. **EOF message** — explicit stream termination reason (no Airbyte equivalent).
6. **setup()/teardown()** — first-class connector lifecycle commands.
7. **Stream metadata** — source-specific metadata on Stream (api_version, account_id).
8. **Spec extensions** — `stream_state` and `input` JSON Schemas on ConnectorSpecification.
9. **Field selection & backfill limits** — on ConfiguredStream.
10. **`MessageBase` envelope** — all messages extend `MessageBase` with `_emitted_by` (origin tag, e.g. `source/stripe`) and `_ts` (ISO 8601 timestamp). Underscore prefix = engine-injected metadata. Airbyte has no equivalent.
11. **`SyncOutput` union** — `pipeline_sync` yields `DestinationOutput | ControlMessage` so source signals (control, log, trace) flow to the caller alongside destination output.
12. **Control messages intercepted during sync** — `pipeline_sync` uses `split()` + `merge()` to fork the read stream, routing source signals to the caller in real-time. The service persists control configs.
