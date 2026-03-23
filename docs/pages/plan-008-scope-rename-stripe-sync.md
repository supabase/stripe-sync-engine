# Plan 008: Rename npm scope `@stripe/` → `@stripe-sync/`

## Context

The `@stripe/` scope is owned by the Stripe npm org and reserved for official
Stripe packages (stripe-node, etc.). sync-engine is a separate project that
should publish under its own scope. `@stripe-sync/` makes the project identity
clear and avoids scope conflicts.

The user also noted: "we're probably going to have a single export later for
the engine itself" — the naming below leaves room for an eventual
`@stripe-sync/engine` or top-level `stripe-sync` package.

## Current packages (15)

| #   | Current name                        | Location                             |
| --- | ----------------------------------- | ------------------------------------ |
| 1   | `@stripe/protocol`                  | `packages/sync-protocol`             |
| 2   | `@stripe/stateless-sync`            | `packages/stateless-sync`            |
| 3   | `@stripe/stateful-sync`             | `packages/stateful-sync`             |
| 4   | `@stripe/source-stripe`             | `packages/source-stripe`             |
| 5   | `@stripe/destination-postgres`      | `packages/destination-postgres`      |
| 6   | `@stripe/destination-google-sheets` | `packages/destination-google-sheets` |
| 7   | `@stripe/util-postgres`             | `packages/util-postgres`             |
| 8   | `@stripe/store-postgres`            | `packages/store-postgres`            |
| 9   | `@stripe/ts-cli`                    | `packages/ts-cli`                    |
| 10  | `@stripe/sync-engine-stateless-cli` | `apps/stateless-cli`                 |
| 11  | `@stripe/sync-engine-stateless-api` | `apps/stateless-api`                 |
| 12  | `@stripe/sync-engine-stateful-cli`  | `apps/stateful-cli`                  |
| 13  | `@stripe/sync-engine-stateful-api`  | `apps/stateful-api`                  |
| 14  | `@stripe/integration-supabase`      | `apps/supabase`                      |
| 15  | `@stripe/test-conformance`          | `tests/conformance`                  |

## Proposed names

Drop redundant "sync" / "sync-engine" prefixes now that the scope carries that
meaning.

| Old                                 | New                                      | Change type          |
| ----------------------------------- | ---------------------------------------- | -------------------- |
| `@stripe/protocol`                  | `@stripe-sync/protocol`                  | scope + drop "sync-" |
| `@stripe/stateless-sync`            | `@stripe-sync/engine`                    | scope + rename       |
| `@stripe/stateful-sync`             | `@stripe-sync/service`                   | scope + rename       |
| `@stripe/source-stripe`             | `@stripe-sync/source-stripe`             | scope only           |
| `@stripe/destination-postgres`      | `@stripe-sync/destination-postgres`      | scope only           |
| `@stripe/destination-google-sheets` | `@stripe-sync/destination-google-sheets` | scope only           |
| `@stripe/util-postgres`             | `@stripe-sync/util-postgres`             | scope only           |
| `@stripe/store-postgres`            | `@stripe-sync/store-postgres`            | scope only           |
| `@stripe/ts-cli`                    | `@stripe-sync/ts-cli`                    | scope only           |
| `@stripe/sync-engine-stateless-cli` | `@stripe-sync/cli`                       | scope + drop prefix  |
| `@stripe/sync-engine-stateless-api` | `@stripe-sync/api`                       | scope + drop prefix  |
| `@stripe/sync-engine-stateful-cli`  | `@stripe-sync/stateful-cli`              | scope + drop prefix  |
| `@stripe/sync-engine-stateful-api`  | `@stripe-sync/stateful-api`              | scope + drop prefix  |
| `@stripe/integration-supabase`      | `@stripe-sync/integration-supabase`      | scope only           |
| `@stripe/test-conformance`          | `@stripe-sync/test-conformance`          | scope only           |

## What to change

### 1. package.json `"name"` fields (15 files)

Every `package.json` listed above.

### 2. package.json `"dependencies"` / `"devDependencies"` (workspace:\* refs)

Every package.json that has `"@stripe/..."` in deps. These are `workspace:*`
references — the key changes but the value stays `workspace:*`.

### 3. Source imports (~40 files)

Every `.ts` file that does `import ... from '@stripe/...'` or
`import('@stripe/...')`. ~35 source files + ~5 test files.

### 4. Docs and markdown (~10 files)

- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `v2-docs/packages.md`
- `v2-docs/cli-spec.md`
- `v2-docs/engine/protocol.md`
- `v2-docs/plan-001-remove-sync-engine-monolith.md`
- `v2-docs/plan-002-move-openapi-to-source-stripe.md`
- `packages/sync-protocol/CONNECTORS.md`

### 5. Lock file

`pnpm install` after all renames regenerates `pnpm-lock.yaml`.

### 6. Memory files

Update `MEMORY.md` and auto-memory references to old package names.

## Execution

Mechanical find-and-replace in this order:

1. Longest names first (avoids partial matches):
   `@stripe/sync-engine-stateless-cli` → `@stripe-sync/cli`, etc.
2. Then shorter names:
   `@stripe/protocol` → `@stripe-sync/protocol`, etc.
3. `pnpm install && pnpm build && pnpm format && pnpm lint && pnpm -r test`

## Verification

```sh
# No stale references
grep -r '@stripe/' --include='*.ts' --include='*.json' --include='*.md' . | grep -v node_modules | grep -v pnpm-lock | grep -v '.prose/'

pnpm install
pnpm build
pnpm format
pnpm lint
pnpm -r test
```
