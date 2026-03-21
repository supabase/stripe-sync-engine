# sync-engine (stateless CLI)

Stateless CLI for running one-off syncs from a source connector to a destination connector.
All inputs must be supplied on each invocation — no persistent storage.

## Install

```sh
pnpm add @stripe/sync-engine-stateless-cli
```

The `sync-engine` binary is added to your PATH.

## SyncParams

Every command takes a `--params` flag with a JSON `SyncParams` object:

```json
{
  "source_name": "stripe",
  "destination_name": "postgres",
  "source_config": { "api_key": "sk_test_..." },
  "destination_config": { "connection_string": "postgresql://user:pass@localhost/mydb" },
  "streams": [
    { "name": "customers", "sync_mode": "incremental" },
    { "name": "charges", "sync_mode": "full_refresh" }
  ],
  "state": {}
}
```

| Field                | Required             | Description                                                                                    |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `destination_name`   | yes                  | Short name (`postgres`), scoped package (`@stripe/destination-postgres`), or file path         |
| `source_name`        | no, default `stripe` | Same format as `destination_name`                                                              |
| `source_config`      | yes                  | Connector-specific config (e.g. `{ "api_key": "sk_..." }`)                                     |
| `destination_config` | yes                  | Connector-specific config (e.g. `{ "connection_string": "..." }`)                              |
| `streams`            | no                   | Stream selection. Omit to sync all discovered streams. `sync_mode` defaults to `full_refresh`. |
| `state`              | no                   | Cursor state from a previous run, used for incremental syncs                                   |

## Commands

### `setup`

Provision external resources — destination tables, source webhook endpoints, etc.

```sh
sync-engine setup --params '{"destination_name":"postgres","source_config":{"api_key":"sk_test_..."},"destination_config":{"connection_string":"postgresql://..."}}'
```

### `teardown`

Clean up external resources previously created by `setup`.

```sh
sync-engine teardown --params '...'
```

### `check`

Validate connectivity to both source and destination. Prints a JSON result to stdout.

```sh
sync-engine check --params '...'
# {"source":{"status":"succeeded"},"destination":{"status":"succeeded"}}
```

### `read`

Read records from the source. Writes NDJSON `Message` objects to stdout.
Optionally accepts NDJSON input on stdin (e.g. to replay webhook events).

```sh
sync-engine read --params '...' > messages.ndjson
```

### `write`

Write messages to the destination. Reads NDJSON `Message` objects from stdin,
writes NDJSON `StateMessage` objects to stdout.

```sh
sync-engine write --params '...' < messages.ndjson
```

### `run`

Full pipeline in one step: read from source and write to destination.
Writes NDJSON `StateMessage` objects to stdout.

```sh
sync-engine run --params '...'
```

## Examples

### Stripe → Postgres full sync

```sh
PARAMS='{
  "source_name": "stripe",
  "destination_name": "postgres",
  "source_config": { "api_key": "sk_test_..." },
  "destination_config": { "connection_string": "postgresql://user:pass@localhost:5432/mydb" }
}'

sync-engine setup  --params "$PARAMS"
sync-engine run    --params "$PARAMS"
```

### Incremental sync with saved state

```sh
# Save state from previous run
sync-engine run --params "$PARAMS" | tee /tmp/run.ndjson | tail -n1 > /tmp/state.json

# Next run: inject saved state
sync-engine run --params "$(jq --slurpfile s /tmp/state.json '.state = $s[0].state' <<< "$PARAMS")"
```

### Read then write as separate steps

```sh
sync-engine read  --params "$PARAMS" | sync-engine write --params "$PARAMS"
```
