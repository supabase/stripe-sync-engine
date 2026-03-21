# sync-engine-stateful (stateful CLI)

Stateful CLI for persistent syncs. Credentials and sync configs are stored as
JSON files in a data directory (`~/.stripe-sync` by default). State and logs
are persisted across runs.

## Install

```sh
pnpm add @stripe/sync-engine-stateful-cli
```

The `sync-engine-stateful` binary is added to your PATH.

## Data directory

All persistent data lives in the data directory (default `~/.stripe-sync`):

| File               | Description                            |
| ------------------ | -------------------------------------- |
| `credentials.json` | Stored credentials (keyed by ID)       |
| `syncs.json`       | Sync configurations (keyed by sync ID) |
| `state.json`       | Per-stream sync state / cursors        |
| `logs.ndjson`      | Append-only NDJSON log                 |

Override with `--data-dir <path>` or `DATA_DIR` env var.

## Commands

All commands accept:

| Option              | Default          | Description           |
| ------------------- | ---------------- | --------------------- |
| `--sync-id <id>`    | `cli_sync`       | Sync ID to operate on |
| `--data-dir <path>` | `~/.stripe-sync` | Data directory        |

### `run`

Run a full sync (read from source, write to destination).

```sh
sync-engine-stateful run [options]
```

### `setup` / `teardown`

Set up or tear down source and destination connectors.

```sh
sync-engine-stateful setup
sync-engine-stateful teardown
```

### `check`

Check source and destination connectivity.

```sh
sync-engine-stateful check
```

### `read` / `write`

Read records from source or write messages to destination. These accept NDJSON
on stdin and emit NDJSON on stdout.

```sh
sync-engine-stateful read
sync-engine-stateful read | sync-engine-stateful write
```

## Examples

### Quick start

1. Create credentials and a sync config in `~/.stripe-sync/`:

```json
// credentials.json
{
  "stripe_cred": {
    "id": "stripe_cred",
    "type": "stripe",
    "api_key": "sk_test_...",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  },
  "pg_cred": {
    "id": "pg_cred",
    "type": "postgres",
    "connection_string": "postgresql://user:pass@localhost:5432/mydb",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

```json
// syncs.json
{
  "cli_sync": {
    "id": "cli_sync",
    "source": { "type": "stripe", "credential_id": "stripe_cred" },
    "destination": { "type": "postgres", "credential_id": "pg_cred" }
  }
}
```

2. Run:

```sh
sync-engine-stateful run
```

### Custom data directory

```sh
sync-engine-stateful run --data-dir ./my-sync-data
```

## Notes

- A `.env` file in the working directory is loaded automatically.
- State persists across runs — subsequent invocations resume from the last cursor.
- Missing connectors are auto-installed via `pnpm add` on first use.
