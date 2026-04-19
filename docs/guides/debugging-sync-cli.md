# Debugging the Sync CLI

The `sync` command spawns the engine HTTP server as a **child process** (`apps/engine/src/cli/subprocess.ts`). This has several implications for debugging.

## Subprocess logs go to a file, not stderr

The sync command pipes the subprocess's stdout and stderr to a log file in the repo root:

- File: `sync-${schema}.log` where `schema` is the `--postgres-schema` arg (default: `public`)
- So usually: **`sync-public.log`**

`console.error()` in connector code (source-stripe, etc.) goes to that file, not the terminal. Check it after a run:

```sh
grep "your_debug_marker" sync-public.log
```

## Live edits propagate immediately (no build/install needed)

The subprocess uses `--conditions bun --import tsx`. The `"bun"` export condition in each workspace package's `package.json` points to `./src/index.ts`, and pnpm symlinks workspace packages (not copies). This means:

- Edits to `.ts` source files in any workspace package are picked up immediately by the subprocess
- No `pnpm build` or `pnpm install` needed between edits
- Just edit, save, re-run the script

This relies on `injectWorkspacePackages` NOT being set in `pnpm-workspace.yaml`. If that setting is ever re-enabled, pnpm will copy files into the store (breaking live propagation) and you'd need `pnpm install` after every edit.

## dist/ is only needed for vitest

| Consumer              | Resolves via         | Points to                                         |
| --------------------- | -------------------- | ------------------------------------------------- |
| Subprocess (sync CLI) | `"bun"` condition    | `./src/index.ts` (live source, transpiled by tsx) |
| Vitest                | `"import"` condition | `./dist/index.js` (compiled output)               |

- The sync CLI does not need dist/ at all
- Vitest does need dist/ — if tests fail with "Cannot find module", rebuild the relevant package
- `apps/supabase` build is Deno-only and frequently fails — you may need to stub `apps/supabase/dist/index.js` for the engine CLI to start (it has a static import)

## Debugging strategy

1. Add `console.error('[MARKER] ...')` to the code you want to trace
2. Run the sync: `./scripts/test-all-accounts.sh prod_goldilocks_sk --quick`
3. Inspect `sync-public.log` (or `sync-{schema}.log`) in the repo root
4. Clean up debug code when done
