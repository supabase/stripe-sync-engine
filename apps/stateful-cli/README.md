# sync-engine-stateful (stateful CLI)

Stateful CLI for persistent syncs. Connector config is resolved from CLI flags,
environment variables, or a config file — connector-agnostic, no hardcoded env var names.

## Install

```sh
pnpm add @stripe/sync-engine-stateful-cli
```

The `sync-engine-stateful` binary is added to your PATH.

## Config resolution

Config is resolved per field using: **CLI flags > env vars > config file > defaults**.

### Environment variables

Env vars use a role prefix (`SOURCE_*`, `DESTINATION_*`). The prefix is stripped
and field names are lowercased:

| Env var                        | Resolves to                              |
| ------------------------------ | ---------------------------------------- |
| `SOURCE_API_KEY=sk_test_...`   | `source_config.api_key = "sk_test_..."`  |
| `DESTINATION_CONNECTION_STRING=pg://...` | `destination_config.connection_string = "pg://..."` |

Values are JSON-parsed where possible (`"true"` → `true`, `"123"` → `123`).

A `.env` file in the working directory is loaded automatically.

### Config file

```sh
sync-engine-stateful run --config sync.json
```

Where `sync.json`:

```json
{
  "source_config": { "api_key": "sk_test_..." },
  "destination_config": { "connection_string": "postgresql://localhost/mydb" }
}
```

### CLI flags

```sh
sync-engine-stateful run \
  --source-config '{"api_key":"sk_test_..."}' \
  --destination-config '{"connection_string":"postgresql://..."}'
```

## Commands

### `run`

Run a sync.

```sh
sync-engine-stateful run [options]
```

| Option                         | Default    | Description                          |
| ------------------------------ | ---------- | ------------------------------------ |
| `--sync-id <id>`               | `cli_sync` | Identifier for this sync run         |
| `--source-type <type>`         | `stripe`   | Source connector short name          |
| `--destination-type <type>`    | `postgres` | Destination connector short name     |
| `--source-config <json>`       |            | Source config as inline JSON         |
| `--destination-config <json>`  |            | Destination config as inline JSON    |
| `--config <path>`              |            | Path to JSON config file             |
| `--data-dir <path>`            | `~/.stripe-sync` | Data directory for state       |

Writes NDJSON `StateMessage` objects to stdout as the sync progresses.

## Examples

### Stripe → Postgres with env vars

```sh
SOURCE_API_KEY=sk_test_... DESTINATION_CONNECTION_STRING=postgresql://... \
  sync-engine-stateful run
```

### Using a config file with env secrets

```json
// sync.json (safe to commit — no secrets)
{
  "source_config": {},
  "destination_config": {}
}
```

```sh
SOURCE_API_KEY=sk_test_... \
DESTINATION_CONNECTION_STRING=postgresql://user:pass@localhost:5432/mydb \
  sync-engine-stateful run --config sync.json
```

### Using a .env file

```sh
# .env
SOURCE_API_KEY=sk_test_...
DESTINATION_CONNECTION_STRING=postgresql://user:pass@localhost:5432/mydb
```

```sh
sync-engine-stateful run
```

## Notes

- State is kept on disk at `~/.stripe-sync/state.json` by default.
- Missing connectors are auto-installed via `pnpm add` on first use.
