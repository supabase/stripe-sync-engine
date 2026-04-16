# Remove Stripe Node SDK from source-stripe

**Date**: 2026-04-04
**Status**: Approved, implementing

## Goal

Replace all Stripe Node SDK HTTP calls in `packages/source-stripe` with a typed
`openapi-fetch` client generated from the bundled Stripe OpenAPI spec. Keep the
SDK only in `apps/service` for webhook signature verification.

## Approach

1. **Type generation**: Run `openapi-typescript` against
   `oas/2026-03-25.dahlia.json` → `src/__generated__/2026-03-25.dahlia.d.ts`
2. **Typed client**: `createStripeFetchClient()` in `packages/openapi` using
   `openapi-fetch` with latest types, `Stripe-Version` header from config
3. **Replace SDK calls**: ~6 call sites in source-stripe (accounts.retrieve,
   webhookEndpoints CRUD, events.list)
4. **Webhook verify**: Inline HMAC-SHA256 in source-stripe (~20 lines)
5. **Remove dep**: Drop `stripe` from source-stripe's package.json

## What stays on raw fetch (no change)

- `buildListFn` / `buildRetrieveFn` in `packages/openapi` — already HTTP-based
- `resourceRegistry` list/retrieve calls — already use the above
- WebSocket client — already uses `fetchWithProxy`

## Package changes

- `packages/openapi`: +`openapi-fetch`, +`openapi-typescript` (dev), new
  `stripeClient.ts`, new generated `.d.ts`
- `packages/source-stripe`: −`stripe`, rewrite `client.ts`, update ~8 files
- `apps/service`: no change
- `e2e/`: keeps `stripe` for test fixtures
