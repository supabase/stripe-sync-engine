# Design: Make `packages/openapi` a Pure Utility (No Transport)

## Problem

`packages/openapi` currently owns HTTP infrastructure: `transport.ts` (proxy logic, undici) and
direct `fetch` calls in `specFetchHelper.ts` and `listFnResolver.ts`. This caused a duplication
of proxy logic between `openapi/transport.ts` and `source-stripe/src/transport.ts` when proxy
support was added in commit `e4149eef`.

The package should be a pure Stripe OpenAPI utility — it may know _what_ to fetch (Stripe-specific
GitHub URLs, commit SHA resolution, version mapping, pagination patterns) but it should not own
_how_ to make HTTP calls (proxy config, undici, NO_PROXY logic).

## Decision

Keep all existing logic in `packages/openapi` — including `specFetchHelper.ts` (the GitHub/Stripe
spec-fetching logic is Stripe-specific and belongs here). Remove the transport infrastructure by
injecting a `fetch` function from the caller instead.

## Design

### API changes

```ts
// specFetchHelper.ts
resolveOpenApiSpec(config: ResolveSpecConfig, fetch: typeof globalThis.fetch): Promise<ResolvedOpenApiSpec>

// listFnResolver.ts
buildListFn(apiKey: string, apiPath: string, fetch: typeof globalThis.fetch, apiVersion?: string, baseUrl?: string): ListFn
buildRetrieveFn(apiKey: string, apiPath: string, fetch: typeof globalThis.fetch, apiVersion?: string, baseUrl?: string): RetrieveFn
```

`fetch` is a **required** parameter — making it optional would silently fall back to
`globalThis.fetch`, which breaks behind Stripe's proxy and defeats the purpose.

### Files removed from `packages/openapi`

- `transport.ts` — deleted entirely
- `undici` — removed from `package.json`

### Call sites updated in `packages/source-stripe`

- `src/index.ts` — passes `fetchWithProxy` to `resolveOpenApiSpec`
- `src/resourceRegistry.ts` — passes `fetchWithProxy` to `buildListFn` / `buildRetrieveFn`

### Tests

- `packages/openapi/__tests__/transport.test.ts` — deleted (tests a file that no longer exists)
- `packages/openapi/__tests__/specFetchHelper.test.ts` — update proxy test to pass a mock fetch
- `packages/openapi/__tests__/listFnResolver.test.ts` — update proxy test to pass a mock fetch

## What does NOT change

- `specFetchHelper.ts` stays in `packages/openapi` — the GitHub repo, commit SHA resolution, and
  version-to-date mapping are Stripe-specific OpenAPI knowledge, not source-stripe business logic
- `source-stripe/src/transport.ts` is untouched
- No behavioral changes — proxy behaviour is identical, just the plumbing moves to the caller
