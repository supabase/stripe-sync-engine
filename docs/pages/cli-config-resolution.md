# CLI Config Resolution Spec

How the CLI resolves the config needed to run a sync. Applies to both
stateless and stateful CLIs (same resolution, different defaults).

## What needs to be resolved

A sync run needs these values:

| Field                | Example                         | Required |
| -------------------- | ------------------------------- | -------- |
| `source`             | `stripe`                        | yes      |
| `destination`        | `postgres`                      | yes      |
| `source_config`      | `{"api_key":"sk_test_..."}`     | yes      |
| `destination_config` | `{"connection_string":"pg://"}` | yes      |
| `streams`            | `["customers","invoices"]`      | no       |

## Config sources (highest priority first)

### 1. CLI flags

Individual flags for each field:

```sh
sync-engine \
  --source stripe \
  --destination postgres \
  --source-config '{"api_key":"sk_test_..."}' \
  --destination-config '{"connection_string":"postgresql://..."}' \
  --streams customers,invoices
```

Or a single JSON blob:

```sh
sync-engine --params '{
  "source": "stripe",
  "destination": "postgres",
  "source_config": {"api_key": "sk_test_..."},
  "destination_config": {"connection_string": "postgresql://..."}
}'
```

`--params` and individual flags can be mixed — individual flags win:

```sh
# params.json has streams=["customers"], but CLI overrides to invoices
sync-engine --params params.json --streams invoices
```

### 2. Environment variables

```sh
export SOURCE_CONFIG='{"api_key":"sk_test_..."}'
export DESTINATION_CONFIG='{"connection_string":"postgresql://..."}'
sync-engine --source stripe --destination postgres
```

| Env var              | Populates            |
| -------------------- | -------------------- |
| `SOURCE_CONFIG`      | `source_config`      |
| `DESTINATION_CONFIG` | `destination_config` |

Env vars only populate config fields (the secret-heavy parts). Connector
types (`source`, `destination`) always come from flags, `--params`, or a
config file — never from env vars alone.

A `.env` file in the working directory is loaded automatically.

### 3. Config file

```sh
sync-engine --config sync.json
```

Where `sync.json`:

```json
{
  "source": "stripe",
  "destination": "postgres",
  "source_config": {
    "api_key": "sk_test_..."
  },
  "destination_config": {
    "connection_string": "postgresql://localhost/mydb"
  },
  "streams": ["customers", "invoices"]
}
```

`--config -` reads from stdin (pipe-friendly).

### 4. Defaults

| Field         | Default                      |
| ------------- | ---------------------------- |
| `source`      | `stripe`                     |
| `destination` | (none)                       |
| `streams`     | all (discovered from source) |

## Resolution order

For each field, the first source that provides a value wins:

```
CLI flag > env var > config file > default
```

`--params` counts as a CLI flag. If both `--params` and an individual flag
set the same field, the individual flag wins.

## Examples

### Minimal — everything from env

```sh
# .env
SOURCE_CONFIG={"api_key":"sk_test_..."}
DESTINATION_CONFIG={"connection_string":"postgresql://localhost/mydb"}
```

```sh
sync-engine --destination postgres
# source defaults to stripe
# source_config from SOURCE_CONFIG env var
# destination_config from DESTINATION_CONFIG env var
# streams auto-discovered
```

### Config file with env secrets

```json
// sync.json — safe to commit (no secrets)
{
  "source": "stripe",
  "destination": "postgres",
  "streams": ["customers", "invoices"]
}
```

```sh
SOURCE_CONFIG='{"api_key":"sk_test_..."}' \
DESTINATION_CONFIG='{"connection_string":"postgresql://..."}' \
sync-engine --config sync.json
```

### One-liner (inline everything)

```sh
sync-engine \
  --source stripe \
  --destination postgres \
  --source-config '{"api_key":"sk_test_..."}' \
  --destination-config '{"connection_string":"postgresql://..."}' \
  --streams customers,invoices
```

### Single JSON blob (pipe-friendly)

```sh
cat sync-params.json | sync-engine --config -
```

### Override a config file field

```sh
# sync.json says streams=["customers"], but we want all streams
sync-engine --config sync.json --streams '*'
```

## Error messages

When a required field is missing, the error should say where it looked:

```
Error: destination_config is required

Provide it via:
  --destination-config '{"connection_string":"..."}'
  DESTINATION_CONFIG='{"connection_string":"..."}' (env var)
  --config sync.json (with destination_config field)
```

## Non-goals

- No env var interpolation inside config files (`$STRIPE_API_KEY` in JSON).
  Use env vars directly or use a config file for non-secret fields + env
  vars for secrets.
- No config file format beyond JSON (no YAML, TOML). JSON is sufficient
  and matches the wire format.
- No per-connector env var conventions (`STRIPE_API_KEY`, `DATABASE_URL`).
  The CLI is connector-agnostic — `SOURCE_CONFIG` and `DESTINATION_CONFIG`
  work with any connector.
