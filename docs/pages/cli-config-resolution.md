# CLI Config Resolution Spec

How the CLI resolves the config needed to run a sync. Applies to both
stateless and stateful CLIs (same resolution, different defaults).

## What needs to be resolved

A sync run needs these values:

| Field         | Example                                                    | Required |
| ------------- | ---------------------------------------------------------- | -------- |
| `source`      | `{"name":"stripe","api_key":"sk_test_..."}`                | yes      |
| `destination` | `{"name":"postgres","connection_string":"pg://"}`          | yes      |
| `streams`     | `["customers","invoices"]`                                 | no       |

## Config sources (highest priority first)

### 1. CLI flags

Individual flags for each field:

```sh
sync-engine \
  --source '{"name":"stripe","api_key":"sk_test_..."}' \
  --destination '{"name":"postgres","connection_string":"postgresql://..."}' \
  --streams customers,invoices
```

Or a single JSON blob:

```sh
sync-engine --params '{
  "source": {"name": "stripe", "api_key": "sk_test_..."},
  "destination": {"name": "postgres", "connection_string": "postgresql://..."}
}'
```

`--params` and individual flags can be mixed — individual flags win:

```sh
# params.json has streams=["customers"], but CLI overrides to invoices
sync-engine --params params.json --streams invoices
```

### 2. Environment variables

```sh
export SOURCE='{"name":"stripe","api_key":"sk_test_..."}'
export DESTINATION='{"name":"postgres","connection_string":"postgresql://..."}'
sync-engine
```

| Env var       | Populates     |
| ------------- | ------------- |
| `SOURCE`      | `source`      |
| `DESTINATION` | `destination` |

Env vars populate the merged connector objects (including name and config).
Connector types can also come from flags, `--params`, or a config file.

A `.env` file in the working directory is loaded automatically.

### 3. Config file

```sh
sync-engine --config sync.json
```

Where `sync.json`:

```json
{
  "source": {
    "name": "stripe",
    "api_key": "sk_test_..."
  },
  "destination": {
    "name": "postgres",
    "connection_string": "postgresql://localhost/mydb"
  },
  "streams": ["customers", "invoices"]
}
```

`--config -` reads from stdin (pipe-friendly).

### 4. Defaults

| Field         | Default                      |
| ------------- | ---------------------------- |
| `source.name` | `stripe`                     |
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
SOURCE={"name":"stripe","api_key":"sk_test_..."}
DESTINATION={"name":"postgres","connection_string":"postgresql://localhost/mydb"}
```

```sh
sync-engine
# source from SOURCE env var (name=stripe, plus config)
# destination from DESTINATION env var
# streams auto-discovered
```

### Config file with env secrets

```json
// sync.json — safe to commit (no secrets)
{
  "source": { "name": "stripe" },
  "destination": { "name": "postgres" },
  "streams": ["customers", "invoices"]
}
```

```sh
SOURCE='{"name":"stripe","api_key":"sk_test_..."}' \
DESTINATION='{"name":"postgres","connection_string":"postgresql://..."}' \
sync-engine --config sync.json
```

### One-liner (inline everything)

```sh
sync-engine \
  --source '{"name":"stripe","api_key":"sk_test_..."}' \
  --destination '{"name":"postgres","connection_string":"postgresql://..."}' \
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
Error: destination is required

Provide it via:
  --destination '{"name":"postgres","connection_string":"..."}'
  DESTINATION='{"name":"postgres","connection_string":"..."}' (env var)
  --config sync.json (with destination field)
```

## Non-goals

- No env var interpolation inside config files (`$STRIPE_API_KEY` in JSON).
  Use env vars directly or use a config file for non-secret fields + env
  vars for secrets.
- No config file format beyond JSON (no YAML, TOML). JSON is sufficient
  and matches the wire format.
- No per-connector env var conventions (`STRIPE_API_KEY`, `DATABASE_URL`).
  The CLI is connector-agnostic — `SOURCE` and `DESTINATION`
  work with any connector.
