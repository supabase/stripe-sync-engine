# ts-cli

Generic CLI infrastructure utilities. Not tied to any specific connector or sync logic.

## Install

```sh
pnpm add @tx-stripe/ts-cli
```

## Config resolution

```ts
import { envPrefix, configFromFile, mergeConfig, parseJsonOrFile } from '@tx-stripe/ts-cli'
```

### `envPrefix(prefix)`

Scan `process.env` for variables matching `PREFIX_*`, strip the prefix,
lowercase field names, and JSON-parse values where possible.

```ts
// Given: SOURCE_API_KEY=sk_test_123  SOURCE_PORT=5432  SOURCE_VERBOSE=true
envPrefix('SOURCE')
// → { api_key: "sk_test_123", port: 5432, verbose: true }
```

Rules:

- Only matches `PREFIX_` followed by more characters (`SOURCE` does not match `SOURCEMAP`)
- Field names are lowercased: `SOURCE_API_KEY` → `api_key`
- Values are JSON-parsed: `"true"` → `true`, `"123"` → `123`, `'{"a":1}'` → `{a: 1}`
- Unparseable values stay as strings: `"hello"` → `"hello"`

### `configFromFile(path)`

Load a JSON config file. Returns `{}` if path is `undefined`.

```ts
configFromFile('./sync.json')
// → { source_config: { api_key: "..." }, destination_config: { ... } }

configFromFile(undefined)
// → {}
```

Throws with a clear message if the file doesn't exist or contains invalid JSON.

### `mergeConfig(...sources)`

Shallow merge where the first source wins per key. Later sources fill in missing
keys only. `undefined` sources are skipped.

```ts
mergeConfig(
  { api_key: 'from_flag' }, // CLI flags (highest priority)
  { api_key: 'from_env', port: 5432 }, // env vars
  { port: 3000, host: 'localhost' } // config file
)
// → { api_key: "from_flag", port: 5432, host: "localhost" }
```

### `parseJsonOrFile(value)`

Parse a CLI flag value as either inline JSON or a file path. If the value
starts with `{` or `[`, it is parsed as JSON. Otherwise it is treated as a
file path and read with `configFromFile`. Returns `{}` for `undefined`.

```ts
parseJsonOrFile('{"api_key":"sk_test_..."}') // → { api_key: "sk_test_..." }
parseJsonOrFile('./stripe-creds.json') // → contents of the file
parseJsonOrFile(undefined) // → {}
```

### Putting it together

Implements the cascade: **CLI flags > env vars > config file > defaults**.

```ts
const config = mergeConfig(
  parseJsonOrFile(opts.sourceConfig), // --source-config '{"api_key":"..."}' or ./creds.json
  envPrefix('SOURCE'), // SOURCE_API_KEY=sk_test_...
  configFromFile(opts.config), // --config sync.json
  { host: 'localhost', port: 5432 } // defaults
)
```
