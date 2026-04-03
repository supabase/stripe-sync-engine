# Service Docker E2E Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `Dockerfile.service`, `compose.service.yml`, and `e2e/service-docker.test.ts` to exercise the full Stripe → Postgres pipeline through real Docker containers.

**Architecture:** The engine container runs the stateless HTTP API; the service container runs the HTTP API (pipeline CRUD); the worker container runs the Temporal worker. All three join the same compose network as the existing infra (temporal, postgres, stripe-mock). The test runner on the host calls the service API at `localhost:4020` and verifies data directly in Postgres at `localhost:55432`.

**Tech Stack:** Docker, docker compose multi-file, `node:24-alpine`, `pnpm deploy`, vitest, `@temporalio/client`, `pg`, `describeWithEnv`

---

### Task 1: `Dockerfile.service`

**Files:**

- Create: `Dockerfile.service`

**Step 1: Create the file**

```dockerfile
# Install deps and create standalone deployment
# Expects pre-built dist/ directories in the build context (from `pnpm build`)
FROM node:24-alpine AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @stripe/sync-service deploy --prod /deploy

# Final image — just the bundle + external node_modules
FROM node:24-alpine
WORKDIR /app

COPY --from=build /deploy/package.json ./
COPY --from=build /deploy/dist ./dist
COPY --from=build /deploy/node_modules ./node_modules

ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/bin/sync-service.js"]
CMD ["serve", "--temporal-address", "temporal:7233", "--temporal-task-queue", "sync-engine"]
```

**Step 2: Verify the build works**

First ensure service is built:

```sh
pnpm build
```

Then build the image:

```sh
docker build -t sync-service-test -f Dockerfile.service .
```

Expected: `Successfully built ...` with no errors. The `pnpm deploy` step may warn about peer deps — that's fine.

**Step 3: Commit**

```sh
git add Dockerfile.service
git commit -m "feat: add Dockerfile.service for sync-service container"
```

---

### Task 2: `compose.service.yml`

**Files:**

- Create: `compose.service.yml`

**Step 1: Create the file**

```yaml
# Application layer — engine + service API + Temporal worker.
# Use together with compose.yml:
#   docker compose -f compose.yml -f compose.service.yml up --build -d
#
# Requires pre-built dist/ in build context: run `pnpm build` first.

services:
  engine:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - '4010:3000'
    environment:
      PORT: '3000'
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1']
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 10s

  service:
    build:
      context: .
      dockerfile: Dockerfile.service
    ports:
      - '4020:4020'
    command:
      - serve
      - --temporal-address
      - temporal:7233
      - --temporal-task-queue
      - sync-engine
      - --port
      - '4020'
    depends_on:
      engine:
        condition: service_healthy
      temporal:
        condition: service_healthy
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://localhost:4020/health || exit 1']
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 10s

  worker:
    build:
      context: .
      dockerfile: Dockerfile.service
    command:
      - worker
      - --temporal-address
      - temporal:7233
      - --temporal-task-queue
      - sync-engine
      - --engine-url
      - http://engine:3000
    depends_on:
      engine:
        condition: service_healthy
      temporal:
        condition: service_healthy
```

**Step 2: Verify the compose file parses**

```sh
docker compose -f compose.yml -f compose.service.yml config --quiet
```

Expected: no output (clean parse), exit 0.

**Step 3: Commit**

```sh
git add compose.service.yml
git commit -m "feat: add compose.service.yml for engine/service/worker containers"
```

---

### Task 3: `e2e/service-docker.test.ts`

**Files:**

- Create: `e2e/service-docker.test.ts`

**Step 1: Create the test file**

```typescript
import { afterAll, beforeAll, expect } from 'vitest'
import { execSync } from 'node:child_process'
import createFetchClient from 'openapi-fetch'
import pg from 'pg'
import path from 'node:path'
import { describeWithEnv } from './test-helpers.js'
import type { paths } from '../apps/service/src/__generated__/openapi.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVICE_URL = 'http://localhost:4020'
// Containers reach Postgres by compose service name; host uses mapped port.
const POSTGRES_CONTAINER_URL = 'postgresql://postgres:postgres@postgres:5432/postgres'
const POSTGRES_HOST_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:55432/postgres'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const COMPOSE_CMD = `docker compose -f compose.yml -f compose.service.yml`

const SKIP_CLEANUP = process.env.SKIP_CLEANUP === '1'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 120_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

function api() {
  return createFetchClient<paths>({ baseUrl: SERVICE_URL })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeWithEnv(
  'service docker e2e: stripe → postgres',
  ['STRIPE_API_KEY'],
  ({ STRIPE_API_KEY }) => {
    let pool: pg.Pool
    let schema: string

    beforeAll(async () => {
      schema = `docker_e2e_${Date.now()}`

      // 1. Build TypeScript so Dockerfiles have fresh dist/
      console.log('\n  Building packages...')
      execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'pipe' })

      // 2. Start engine + service + worker containers (infra already running)
      console.log('  Starting containers...')
      execSync(`${COMPOSE_CMD} up --build -d engine service worker`, {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      })

      // 3. Wait for service HTTP API to be ready
      console.log('  Waiting for service health...')
      await pollUntil(async () => {
        try {
          const r = await fetch(`${SERVICE_URL}/health`)
          return r.ok
        } catch {
          return false
        }
      })

      // 4. Open Postgres pool on host-mapped port for verification
      pool = new pg.Pool({ connectionString: POSTGRES_HOST_URL })
      await pool.query('SELECT 1')

      console.log(`  Service:  ${SERVICE_URL}`)
      console.log(`  Schema:   ${schema}`)
      console.log(`  Postgres: ${POSTGRES_HOST_URL}`)
      console.log(`  Cleanup:  ${SKIP_CLEANUP ? 'no (SKIP_CLEANUP=1)' : 'yes'}`)
    }, 5 * 60_000) // 5 min — includes docker build

    afterAll(async () => {
      if (!SKIP_CLEANUP) {
        await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
      }
      await pool?.end().catch(() => {})

      // Stop only app containers — leave infra (postgres, temporal, stripe-mock) running
      execSync(`${COMPOSE_CMD} stop engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
      execSync(`${COMPOSE_CMD} rm -f engine service worker`, { cwd: REPO_ROOT, stdio: 'pipe' })
    })

    it('create pipeline → data lands in Postgres → delete', async () => {
      const c = api()

      // --- Create ---
      const { data: created, error: createErr } = await c.POST('/pipelines', {
        body: {
          source: { type: 'stripe', api_key: STRIPE_API_KEY },
          destination: {
            type: 'postgres',
            connection_string: POSTGRES_CONTAINER_URL,
            schema,
          },
          streams: [{ name: 'products', backfill_limit: 500 }],
        },
      })
      expect(createErr).toBeUndefined()
      expect(created!.id).toMatch(/^pipe_/)
      const id = created!.id
      console.log(`\n  Pipeline: ${id}`)

      // --- Wait for data ---
      await pollUntil(async () => {
        try {
          const r = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."products"`)
          return r.rows[0].n > 0
        } catch {
          return false
        }
      })

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."products"`)
      console.log(`  Synced:   ${rows[0].n} products`)
      expect(rows[0].n).toBeGreaterThan(0)

      // Verify shape
      const { rows: sample } = await pool.query(`SELECT id FROM "${schema}"."products" LIMIT 1`)
      expect(sample[0].id).toMatch(/^prod_/)

      // --- List includes the pipeline ---
      const { data: list } = await c.GET('/pipelines')
      expect(list!.data.some((p: { id: string }) => p.id === id)).toBe(true)

      // --- Get returns status ---
      const { data: got } = await c.GET('/pipelines/{id}', { params: { path: { id } } })
      expect(got!.status?.phase).toBeDefined()

      // --- Delete ---
      const { data: deleted, error: deleteErr } = await c.DELETE('/pipelines/{id}', {
        params: { path: { id } },
      })
      expect(deleteErr).toBeUndefined()
      expect(deleted).toEqual({ id, deleted: true })

      // --- Verify gone from list and get ---
      const { data: listAfter } = await c.GET('/pipelines')
      expect(listAfter!.data.find((p: { id: string }) => p.id === id)).toBeUndefined()

      const { error: getAfter } = await c.GET('/pipelines/{id}', { params: { path: { id } } })
      expect(getAfter).toBeDefined()
    }, 120_000)
  }
)
```

**Step 2: Check the openapi import path**

The test imports `openapi.js` from the service's generated types. Verify the path resolves:

```sh
ls apps/service/src/__generated__/openapi.d.ts
```

Expected: file exists. If it's `openapi.d.ts` but the import uses `openapi.js`, that's correct — TypeScript resolves `.d.ts` from `.js` imports with `"moduleResolution": "bundler"` or `"nodenext"`.

**Step 3: Run the test (requires STRIPE_API_KEY)**

```sh
STRIPE_API_KEY=sk_test_... pnpm --filter @stripe/sync-e2e test -- --reporter=verbose service-docker
```

Or from repo root:

```sh
STRIPE_API_KEY=sk_test_... pnpm test:e2e -- service-docker
```

Expected: beforeAll takes 2-4 minutes (docker build + start), test passes within 2 minutes.

If test fails mid-run and you want to inspect Postgres:

```sh
SKIP_CLEANUP=1 STRIPE_API_KEY=sk_test_... pnpm test:e2e -- service-docker
```

**Step 4: Commit**

```sh
git add e2e/service-docker.test.ts
git commit -m "feat: add service docker e2e test (stripe -> postgres via containers)"
```

---

### Task 4: Update memory — `type` discriminator

**Files:**

- Modify: `/Users/tx/.claude/projects/-Users-tx-stripe-github-stripe-sync-engine/memory/MEMORY.md`

The memory entry says "source/destination schemas use `name` as the discriminator field (not `type`)" but `apps/service/src/lib/createSchemas.ts` uses `type`. Update the memory to reflect the actual code.

**Step 1: Update MEMORY.md**

Find the entry containing `` `name` vs `type` discriminator `` and update it to say the service API uses `type` as the discriminator (built dynamically by `createSchemas.ts` via `obj.extend({ type: z.literal(name) })`).

**Step 2: Commit**

```sh
git add /Users/tx/.claude/projects/.../memory/MEMORY.md
# no commit needed — memory files aren't in the repo
```

---

## Running the full suite

```sh
# Bring up infra first (if not already running):
docker compose up -d

# Run the docker e2e test:
STRIPE_API_KEY=sk_test_... pnpm --filter @stripe/sync-e2e test -- service-docker

# Tear down everything when done:
docker compose -f compose.yml -f compose.service.yml down
```
