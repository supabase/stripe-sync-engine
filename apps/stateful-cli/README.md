# sync-engine-stateful (stateful CLI)

Stateful CLI for persistent syncs. Credentials are read from environment variables;
sync state is kept in memory per invocation (no external store needed).

Useful for quick local runs or scripted pipelines where you control the environment.

## Install

```sh
pnpm add @stripe/sync-engine-stateful-cli
```

The `sync-engine-stateful` binary is added to your PATH.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `STRIPE_API_KEY` | yes (source) | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `DATABASE_URL` | yes (destination) | Postgres connection string (`postgresql://user:pass@host/db`) |

A `.env` file in the working directory is loaded automatically.

## Commands

### `run`

Run a sync using environment credentials and in-memory state.

```sh
sync-engine-stateful run [options]
```

| Option | Default | Description |
|---|---|---|
| `--sync-id <id>` | `cli_sync` | Identifier for this sync run (used in log output) |
| `--source-type <type>` | `stripe` | Source connector short name |
| `--destination-type <type>` | `postgres` | Destination connector short name |

Writes NDJSON `StateMessage` objects to stdout as the sync progresses.

## Examples

### Stripe → Postgres with defaults

```sh
STRIPE_API_KEY=sk_test_... DATABASE_URL=postgresql://... sync-engine-stateful run
```

### Named run with custom sync ID

```sh
STRIPE_API_KEY=sk_test_... \
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb \
sync-engine-stateful run --sync-id nightly_sync
```

### Using a .env file

```sh
# .env
STRIPE_API_KEY=sk_test_...
DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
```

```sh
sync-engine-stateful run --sync-id my_sync
```

## Notes

- State is held in memory only — each `run` starts a fresh full sync. Use the
  [stateful API](../stateful-api/README.md) if you need incremental resumption across runs.
- Missing connectors are auto-installed via `pnpm add` on first use.
