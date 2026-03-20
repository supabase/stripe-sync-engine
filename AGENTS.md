# Sync Engine — Agent Instructions

## Build & Run

This is a pnpm monorepo. The main package is `packages/sync-engine`.

```sh
pnpm install
pnpm build          # required before running CLI or e2e tests
```

**You must build before running the CLI.** `tsx` and `node --experimental-strip-types`
do not work because the codebase uses `?raw` imports (bundler feature) and
`import ... with { type: 'json' }` (import attributes).

For dev with auto-rebuild: `cd packages/sync-engine && pnpm dev`

## Testing

```sh
pnpm test                # unit tests (no deps needed)
pnpm test:integration    # needs local Postgres
pnpm test:e2e            # needs Docker + Stripe API keys in .env
```

## Before Committing

Always run these — CI enforces them:

```sh
pnpm format          # prettier (CI runs format:check)
pnpm lint
pnpm build
```

If you edit migrations, also verify `migrations-embedded.ts` is up to date:
`pnpm build && pnpm format` then check `git diff`.

## Monorepo Layout

- `packages/sync-engine` — core sync engine + CLI (published as `@stripe/sync-engine`)
- `packages/source-stripe` — Stripe source connector + webhook ingress server (Fastify)
- `packages/sync-engine/src/supabase` — Supabase edge functions (Deno runtime, not Node)

## GitHub Workflow

When asked to push to GitHub, monitor CI checks until they all pass before
reporting back. Don't just push and return — keep polling `gh pr checks` or
`gh run watch` until all checks are green (or report failures if they occur).

## Conventions

- All serializable inputs/outputs (Zod schemas, JSON wire format) must use **snake_case** field names.

## Key Gotchas

- `tsx` fails on this project — `?raw` imports pull in Deno-only code. Use built output.
- `packages/sync-engine/src/supabase` is Deno, not Node. Don't try to run those files with Node/tsx.
- E2E tests need Stripe keys with **write** permissions (they create real objects).
