# Engine Binary Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the engine into an interactive CLI binary and a minimal bundled-only serve binary, while making the API module surface import-safe and side-effect-free.

**Architecture:** Keep connector discovery policy outside `startApiServer()` by passing it a prebuilt resolver. Move dotenv/env-proxy bootstrap into shared `src/bin/bootstrap.ts`, route the full CLI through `src/bin/sync-engine.ts`, and route the minimal HTTP server through `src/bin/serve.ts`. Preserve `createApp()` as the pure app factory and make `src/api/index.ts` export-only.

**Tech Stack:** TypeScript, Vitest, Hono, citty, Node/Bun runtime entrypoints

---

### Task 1: Lock in the new runtime boundaries with tests

**Files:**
- Create: `apps/engine/src/api/index.test.ts`
- Create: `apps/engine/src/__tests__/bin-serve.test.ts`
- Modify: `apps/engine/src/api/index.ts`
- Modify: `apps/engine/src/bin/serve.ts`

**Step 1: Write the failing tests**

Add tests that prove:
1. Importing `apps/engine/src/api/index.ts` does not start a server or resolve connectors, and it exports `createApp` plus `startApiServer`.
2. Importing `apps/engine/src/bin/serve.ts` bootstraps dotenv/env-proxy, builds a resolver from `defaultConnectors` with `{ path: false, npm: false }`, and passes that resolver into `startApiServer()`.

**Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/api/index.test.ts src/__tests__/bin-serve.test.ts`

Expected: FAIL because `src/api/index.ts` is currently a runnable server entrypoint and `src/bin/serve.ts` does not exist yet.

**Step 3: Implement the minimal code to make the tests pass**

Create:
- `apps/engine/src/bin/bootstrap.ts`
- `apps/engine/src/bin/serve.ts`
- `apps/engine/src/api/server.ts`

Refactor:
- `apps/engine/src/api/index.ts` into an export-only module surface.

**Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/api/index.test.ts src/__tests__/bin-serve.test.ts`

Expected: PASS

### Task 2: Move the interactive CLI to its own binary and keep serve policy outside startup

**Files:**
- Create: `apps/engine/src/bin/sync-engine.ts`
- Modify: `apps/engine/src/cli/command.ts`
- Delete: `apps/engine/src/cli/index.ts`
- Delete: `apps/engine/src/serve-command.ts`
- Modify: `apps/engine/src/index.ts`
- Modify: `apps/engine/package.json`

**Step 1: Write the failing test or assertion**

Use the Task 1 coverage plus a focused CLI smoke check to prove the new binary layout exists and imports cleanly.

**Step 2: Run verification to capture the gap**

Run: `pnpm exec vitest run src/api/index.test.ts src/__tests__/bin-serve.test.ts`

Expected: Existing tests stay green while the old runtime layout still points package bins at `dist/cli/index.js`.

**Step 3: Write minimal implementation**

Implement:
1. `src/bin/sync-engine.ts` as the citty/OpenAPI entrypoint using shared bootstrap.
2. `src/cli/command.ts` so `serve` calls `startApiServer({ resolver, port })` with the CLI-built resolver.
3. `apps/engine/package.json` bin/script/exports updates:
   - `sync-engine` -> `dist/bin/sync-engine.js`
   - `sync-engine-serve` -> `dist/bin/serve.js`
   - `dev` -> `src/bin/serve.ts`
   - `./api` export -> `dist/api/index.js`

**Step 4: Verify the new binaries exist and behave**

Run:
- `pnpm build`
- `node dist/bin/sync-engine.js --help`

Expected:
- build succeeds
- help output shows the interactive CLI, including `serve`

### Task 3: Repoint operational callsites and verify the minimal server path

**Files:**
- Modify: `Dockerfile`
- Modify: `scripts/open-docs.sh`
- Modify: `e2e/header-size-docker.test.ts`
- Modify: `e2e/test-disconnect.test.ts`
- Modify: `docs/slides/step5-engine.sh`
- Modify: `demo/stripe-to-postgres-live.sh`
- Modify: `demo/stripe-to-postgres.sh`
- Modify: `demo/stripe-to-google-sheets.sh`
- Modify: `docs/architecture/packages.md`
- Modify: `docs/guides/cli-spec.md`

**Step 1: Update runtime callsites only**

Repoint current operational scripts, tests, and active docs to:
- `src/bin/serve.ts`
- `src/bin/sync-engine.ts`
- `dist/bin/serve.js`
- `dist/bin/sync-engine.js`

Do not rewrite historical or completed plan docs that intentionally preserve older paths.

**Step 2: Run focused verification**

Run:
- `pnpm lint`
- `pnpm exec vitest run src/api/index.test.ts src/__tests__/bin-serve.test.ts`
- `node apps/engine/dist/bin/serve.js`
- `PORT=4000 node apps/engine/dist/bin/serve.js`

Expected:
- lint passes
- focused tests pass
- `/health` is reachable on default port `3000`
- `/health` is reachable on overridden port `4000`

**Step 3: Full package verification**

Run:
- `pnpm build`
- `pnpm --filter @stripe/sync-engine test`

Expected:
- build succeeds
- package tests are green except for environment-dependent Docker coverage if Docker is unavailable
