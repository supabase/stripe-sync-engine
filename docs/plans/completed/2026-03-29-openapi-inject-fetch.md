# openapi: inject fetch, remove transport Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all HTTP infrastructure from `packages/openapi` by injecting a required `fetch` parameter, eliminating the duplicated `transport.ts` and `undici` dependency.

**Architecture:** Three public functions gain a required `fetch: typeof globalThis.fetch` parameter. The two source-stripe call sites pass `fetchWithProxy` from their existing transport. `packages/openapi/transport.ts` and its tests are deleted; `undici` is removed from the package.

**Tech Stack:** TypeScript, Vitest, pnpm workspace

---

### Task 1: Update `buildListFn` and `buildRetrieveFn` to accept injected fetch

**Files:**

- Modify: `packages/openapi/listFnResolver.ts`

**Step 1: Add `fetch` as the third required parameter to both functions**

In `listFnResolver.ts`, change:

```ts
// Remove this import at the top:
import { fetchWithProxy } from './transport.js'
```

Change `buildListFn` signature from:

```ts
export function buildListFn(
  apiKey: string,
  apiPath: string,
  apiVersion?: string,
  baseUrl?: string
): ListFn {
```

To:

```ts
export function buildListFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion?: string,
  baseUrl?: string
): ListFn {
```

Change `buildRetrieveFn` signature from:

```ts
export function buildRetrieveFn(
  apiKey: string,
  apiPath: string,
  apiVersion?: string,
  baseUrl?: string
): RetrieveFn {
```

To:

```ts
export function buildRetrieveFn(
  apiKey: string,
  apiPath: string,
  fetch: typeof globalThis.fetch,
  apiVersion?: string,
  baseUrl?: string
): RetrieveFn {
```

Replace all four `fetchWithProxy(...)` calls inside those functions with `fetch(...)`.

**Step 2: Run tests to verify they fail at the call sites**

```bash
cd packages/openapi && pnpm test 2>&1 | grep -E "FAIL|Error|pass|fail" | head -20
```

Expected: TypeScript/test errors at call sites that still pass 4 args.

---

### Task 2: Update `resolveOpenApiSpec` to accept injected fetch

**Files:**

- Modify: `packages/openapi/specFetchHelper.ts`

**Step 1: Change the function signature**

Remove:

```ts
import { fetchWithProxy } from './transport.js'
```

Change the function signature from:

```ts
export async function resolveOpenApiSpec(config: ResolveSpecConfig): Promise<ResolvedOpenApiSpec> {
```

To:

```ts
export async function resolveOpenApiSpec(
  config: ResolveSpecConfig,
  fetch: typeof globalThis.fetch
): Promise<ResolvedOpenApiSpec> {
```

Replace all three `fetchWithProxy(...)` calls inside `resolveLatestCommitSha`, `resolveCommitShaForApiVersion`, and `fetchSpecForCommit` with `fetch(...)`. These are private functions — thread the `fetch` parameter through them:

```ts
async function resolveLatestCommitSha(fetch: typeof globalThis.fetch): Promise<string | null>
async function resolveCommitShaForApiVersion(
  apiVersion: string,
  fetch: typeof globalThis.fetch
): Promise<string | null>
async function fetchSpecForCommit(
  commitSha: string,
  fetch: typeof globalThis.fetch
): Promise<OpenApiSpec>
```

Update the call sites inside `resolveOpenApiSpec` to pass `fetch` along.

---

### Task 3: Delete `transport.ts` from `packages/openapi`

**Files:**

- Delete: `packages/openapi/transport.ts`
- Modify: `packages/openapi/package.json`

**Step 1: Delete the file**

```bash
rm packages/openapi/transport.ts
```

**Step 2: Remove `undici` from `packages/openapi/package.json`**

In `packages/openapi/package.json`, remove:

```json
"dependencies": {
  "undici": "^7.16.0"
}
```

Replace with:

```json
"dependencies": {}
```

**Step 3: Run install to update lockfile**

```bash
pnpm install
```

---

### Task 4: Update openapi tests — delete transport test, fix proxy tests

**Files:**

- Delete: `packages/openapi/__tests__/transport.test.ts`
- Modify: `packages/openapi/__tests__/listFnResolver.test.ts`
- Modify: `packages/openapi/__tests__/specFetchHelper.test.ts`

**Step 1: Delete the transport test file**

```bash
rm packages/openapi/__tests__/transport.test.ts
```

**Step 2: Update listFnResolver proxy tests**

The two proxy tests currently rely on `HTTPS_PROXY` env var + `vi.stubGlobal('fetch', ...)` to verify the proxy helper was used. Since fetch is now injected directly, the tests become simpler — just pass the mock fetch directly and remove the env var setup.

Replace the `'routes list and retrieve fetches through the proxy helper'` test with:

```ts
it('uses the injected fetch for list and retrieve calls', async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
  )

  const list = buildListFn('sk_test_fake', '/v1/customers', fetchMock)
  const retrieve = buildRetrieveFn('sk_test_fake', '/v1/customers', fetchMock)

  await list({ limit: 1 })
  await retrieve('cus_123')

  expect(fetchMock).toHaveBeenCalledTimes(2)
})
```

Replace the `'bypasses the proxy for localhost base URLs'` test with:

```ts
it('uses the injected fetch for localhost base URLs', async () => {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 })
  )

  const list = buildListFn(
    'sk_test_fake',
    '/v1/customers',
    fetchMock,
    undefined,
    'http://localhost:12111'
  )
  await list({ limit: 1 })

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('http://localhost:12111'),
    expect.anything()
  )
})
```

Remove the `afterEach` with `vi.unstubAllGlobals` / `vi.restoreAllMocks` if it was only needed for the proxy tests.

**Step 3: Update specFetchHelper proxy test**

Replace the `'uses the configured proxy for GitHub fetches'` test. It currently sets `HTTPS_PROXY` and stubs global fetch. Change it to pass the mock fetch directly:

```ts
it('uses the injected fetch for GitHub fetches', async () => {
  const tempDir = await createTempDir('openapi-fetch-proxy')

  const fetchMock = vi.fn(async (input: URL | string) => {
    const url = String(input)
    if (url.includes('/commits')) {
      return new Response(JSON.stringify([{ sha: 'abc123def456' }]), { status: 200 })
    }
    return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
  })

  try {
    const result = await resolveOpenApiSpec(
      { apiVersion: '2020-08-27', cacheDir: tempDir },
      fetchMock
    )
    expect(result.source).toBe('github')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})
```

Also update all other `resolveOpenApiSpec(...)` calls in `specFetchHelper.test.ts` that don't use `fetchMock` — pass `vi.fn()` or `fetchMock` as the second argument. Check each test: any test that reads from a local file path or cache should pass a `vi.fn()` that throws (to confirm it's never called).

**Step 4: Run openapi tests**

```bash
cd packages/openapi && pnpm test 2>&1 | tail -20
```

Expected: all tests pass, no transport.test.ts.

---

### Task 5: Update source-stripe call sites

**Files:**

- Modify: `packages/source-stripe/src/resourceRegistry.ts`
- Modify: `packages/source-stripe/src/index.ts`

**Step 1: Update `resourceRegistry.ts`**

Add import:

```ts
import { fetchWithProxy } from './transport.js'
```

Change:

```ts
listFn: buildListFn(apiKey, endpoint.apiPath, apiVersion, baseUrl),
retrieveFn: buildRetrieveFn(apiKey, endpoint.apiPath, apiVersion, baseUrl),
```

To:

```ts
listFn: buildListFn(apiKey, endpoint.apiPath, fetchWithProxy, apiVersion, baseUrl),
retrieveFn: buildRetrieveFn(apiKey, endpoint.apiPath, fetchWithProxy, apiVersion, baseUrl),
```

**Step 2: Update `index.ts`**

Add import:

```ts
import { fetchWithProxy } from './transport.js'
```

Change both `resolveOpenApiSpec({ ... })` calls to `resolveOpenApiSpec({ ... }, fetchWithProxy)`.

**Step 3: Run source-stripe tests**

```bash
cd packages/source-stripe && pnpm test 2>&1 | tail -20
```

Expected: all tests pass.

---

### Task 6: Build, final test run, and commit

**Step 1: Build the whole workspace**

```bash
pnpm build 2>&1 | tail -20
```

Expected: clean build, no TypeScript errors.

**Step 2: Run all tests**

```bash
pnpm test 2>&1 | grep -E "Test Files|Tests |FAIL" | head -20
```

Expected: no failures beyond Docker-dependent tests.

**Step 3: Regenerate OpenAPI spec if needed**

Check if any engine routes were touched (they weren't — this change is all in openapi/source-stripe). Skip if build is clean.

**Step 4: Commit**

```bash
git add packages/openapi/ packages/source-stripe/src/resourceRegistry.ts packages/source-stripe/src/index.ts pnpm-lock.yaml
git commit -m "refactor(openapi): inject fetch, remove transport.ts and undici dependency"
```
