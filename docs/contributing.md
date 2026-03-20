# Contributing

Thanks for your interest in Stripe Sync Engine.

This project is currently accepting code contributions only. Docs are maintained by project maintainers.

## Quick Workflow

1. Fork the repo and create a branch.
2. Make your changes.
3. Run relevant checks locally.
4. Open a pull request with a clear description.

## Development Setup

This repo uses `pnpm` workspaces.

```sh
pnpm install
```

### Build

The sync-engine package must be built before the fastify-app tests can run.
The Supabase edge functions use Vite `?raw` imports and `import ... with { type: 'json' }`
(import attributes), both of which require a bundler — they can't be executed directly
by `node` or `tsx`.

```sh
pnpm build
```

### Running Tests

**Unit tests** (no external dependencies):

```sh
pnpm test
```

This runs tests across all workspace packages. The sync-engine unit tests are
pure mocks. The fastify-app tests cover the small internal HTTP contract and do
not require Postgres.

**Integration tests** (requires Postgres):

```sh
cd packages/sync-engine && pnpm test:integration
```

**E2E tests** (requires Postgres via Docker + Stripe API keys):

```sh
cd packages/sync-engine && pnpm test:e2e
```

E2E tests spin up isolated Postgres containers via Docker and make real Stripe
API calls. They require these environment variables:

| Variable           | Required for        |
| ------------------ | ------------------- |
| `STRIPE_API_KEY`   | All e2e tests       |
| `STRIPE_API_KEY_2` | Webhook reuse tests |
| `STRIPE_API_KEY_3` | Sigma tests         |

The API keys need **write permissions** (`rak_customer_write`, `rak_product_write`,
`rak_feature_write`) because the tests create and delete Stripe objects to verify
the sync pipeline end-to-end.

Copy `.env.sample` to `.env` in `packages/sync-engine/` and fill in your keys.

### Dev Mode (watch + auto-rebuild)

For iterative development with automatic rebuilds on file changes:

```sh
cd packages/sync-engine
pnpm run build:functions   # one-time: generate edge function bundles + migrations-embedded.ts
STRIPE_API_KEY=<key> DATABASE_URL=<url> pnpm dev
```

This uses `tsup --watch` to incrementally rebuild the TypeScript source (~300ms),
copies SQL migrations into `dist/`, and re-runs the sync command on every change.

**Why not `tsx` or `node --experimental-strip-types` directly?**

The codebase uses two features that prevent running `.ts` source files directly:

1. **`?raw` imports** — The Supabase edge function code is embedded as strings
   via Vite-style `import ... from './file.ts?raw'` syntax. This is a bundler
   feature that `tsx` and Node's type stripping don't understand. Without a
   bundler, the import resolves to the actual module, which pulls in Deno-only
   dependencies (`postgres`) that don't exist in the Node environment.

2. **Import attributes** — `import pkg from '../../package.json' with { type: 'json' }`
   requires Node 22+ with `--experimental-strip-types`, but this flag doesn't
   support the `with` syntax for type-only imports in all cases.

`tsup --watch` is the pragmatic middle ground: it handles both features, rebuilds
in milliseconds, and the `--onSuccess` hook restarts the process automatically.

### CLI Usage

After building, run the CLI directly:

```sh
# Full sync from Stripe into Postgres
node packages/sync-engine/dist/cli/index.js sync \
  --stripe-key <STRIPE_API_KEY> \
  --database-url <DATABASE_URL>

# Sync + listen for live events via WebSocket
node packages/sync-engine/dist/cli/index.js sync \
  --listen-mode websocket \
  --stripe-key <STRIPE_API_KEY> \
  --database-url <DATABASE_URL>

# Listen only (skip initial backfill)
node packages/sync-engine/dist/cli/index.js sync \
  --listen-only \
  --listen-mode websocket \
  --stripe-key <STRIPE_API_KEY> \
  --database-url <DATABASE_URL>

# Run migrations only
node packages/sync-engine/dist/cli/index.js migrate \
  --database-url <DATABASE_URL>
```

### Common Checks

```sh
pnpm lint
pnpm test
pnpm format:check
```

### CI

CI runs on every PR and push to `main`. It runs lint, format checks, build,
unit tests, integration tests, and e2e tests. See `.github/workflows/ci.yml`
for the full pipeline.

The e2e job requires GitHub repository secrets for the Stripe API keys.
Only `STRIPE_API_KEY`, `STRIPE_API_KEY_2`, `STRIPE_API_KEY_3`, and `NPM_TOKEN`
are actively used. `NGROK_AUTH_TOKEN` is set in CI but not read by any test.
