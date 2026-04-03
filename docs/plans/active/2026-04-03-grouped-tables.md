# Plan: Grouped Stripe Tables in Stream Selector

## Context

The dashboard's `StreamSelector` already renders groups as collapsible sections, but the grouping algorithm has gaps. The current `inferGroupName()` uses prefix heuristics with a `REFINEMENTS` map missing ~15 entries — causing orphan groups like "Topup", "Quote", "Review", "Shipping", "Financial", "Terminal", etc. instead of proper category assignment.

The fix adds an optional `group` field to the `Stream` protocol so source connectors can provide authoritative grouping. The Stripe connector populates it; the dashboard uses it directly and falls back to prefix inference for other sources. Groups are also displayed in semantic priority order instead of alphabetically.

## Worktree

```sh
git worktree add .worktrees/grouped-tables -b tx/grouped-tables v2
```

## Files to Modify

| File                                           | Change                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `packages/protocol/src/protocol.ts`            | Add `group?: string` to `Stream` schema                          |
| `packages/source-stripe/src/catalog.ts`        | Populate `group` in both catalog functions                       |
| `apps/dashboard/src/lib/stream-groups.ts`      | Prefer `stream.group`, expand REFINEMENTS fallback, add ordering |
| `apps/dashboard/src/lib/stream-groups.test.ts` | Add test cases                                                   |
| `./scripts/generate-openapi.sh`                | Run after protocol change to regenerate specs                    |

---

## Step 1 — Protocol (`packages/protocol/src/protocol.ts`)

Add `group` after `name` in the `Stream` Zod schema:

```ts
export const Stream = z.object({
  name: z.string(),

  /**
   * Optional product group this stream belongs to (e.g. "Payments", "Billing", "Issuing").
   * Provided by the source connector when known; consumers should fall back to
   * name-based inference when absent.
   */
  group: z.string().optional(),

  primary_key: z.array(z.array(z.string())),
  // ... rest unchanged
})
```

---

## Step 2 — Stripe source (`packages/source-stripe/src/catalog.ts`)

Add lookup maps and an `inferGroup(tableName)` helper. Populate `group` on every stream in both `catalogFromRegistry` and `catalogFromOpenApi`.

```ts
// Exact table names that can't be inferred from prefix alone
const EXACT: Record<string, string> = {
  topup: 'Payments',
  quote: 'Billing',
  review: 'Radar',
}

// Two-word prefixes (checked before single-word)
const TWO_WORD: Record<string, string> = {
  billing_portal: 'Billing Portal',
}

// Single-word prefix → group
const PREFIX: Record<string, string> = {
  payment: 'Payments',
  charge: 'Payments',
  refund: 'Payments',
  dispute: 'Payments',
  setup: 'Payments',
  payout: 'Payments',
  customer: 'Customers',
  subscription: 'Billing',
  invoice: 'Billing',
  credit: 'Billing',
  price: 'Billing',
  plan: 'Billing',
  coupon: 'Billing',
  quote: 'Billing',
  promotion: 'Billing',
  product: 'Products',
  shipping: 'Products',
  account: 'Connect',
  application: 'Connect',
  transfer: 'Transfers',
  balance: 'Transfers',
  checkout: 'Checkout',
  issuing: 'Issuing',
  treasury: 'Treasury',
  terminal: 'Terminal',
  radar: 'Radar',
  early: 'Radar',
  identity: 'Identity',
  financial: 'Financial Connections',
  reporting: 'Reporting',
  sigma: 'Sigma',
  climate: 'Climate',
  entitlements: 'Entitlements',
  forwarding: 'Forwarding',
  apps: 'Apps',
  tax: 'Tax',
  file: 'Files',
  event: 'Events',
  webhook: 'Webhooks',
}

function inferGroup(tableName: string): string {
  if (EXACT[tableName]) return EXACT[tableName]
  const parts = tableName.split('_')
  const two = parts.slice(0, 2).join('_')
  if (TWO_WORD[two]) return TWO_WORD[two]
  return PREFIX[parts[0]] ?? capitalize(parts[0])
}
```

In both catalog functions, add `group: inferGroup(cfg.tableName)` to each stream object:

```ts
const stream: Stream = {
  name: cfg.tableName,
  group: inferGroup(cfg.tableName), // ← add
  primary_key: [['id']],
  metadata: { resource_name: name },
}
```

---

## Step 3 — Dashboard (`apps/dashboard/src/lib/stream-groups.ts`)

### a) Add `group` to `CatalogStream` interface

```ts
export interface CatalogStream {
  name: string
  group?: string // ← add
  primary_key: string[][]
  json_schema?: Record<string, unknown>
  metadata?: Record<string, unknown>
}
```

### b) Prefer `stream.group` in `groupStreams`

```ts
for (const stream of streams) {
  const groupName = stream.group ?? inferGroupName(stream.name)
  // ...
}
```

### c) Canonical group ordering (replace alphabetical sort)

```ts
const GROUP_ORDER = [
  'Payments',
  'Customers',
  'Billing',
  'Products',
  'Connect',
  'Transfers',
  'Checkout',
  'Issuing',
  'Treasury',
  'Terminal',
  'Radar',
  'Identity',
  'Financial Connections',
  'Reporting',
  'Sigma',
  'Climate',
  'Entitlements',
  'Forwarding',
  'Apps',
  'Tax',
  'Billing Portal',
  'Events',
  'Webhooks',
  'Files',
]

function groupOrder(name: string): number {
  const idx = GROUP_ORDER.indexOf(name)
  return idx === -1 ? GROUP_ORDER.length : idx
}

// In groupStreams():
return [...groups.entries()]
  .sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b))
  .map(([name, streams]) => ({
    name,
    streams: streams.sort((a, b) => a.name.localeCompare(b.name)),
  }))
```

### d) Expand `REFINEMENTS` fallback

Update `REFINEMENTS` in `inferGroupName` with the same mappings as `PREFIX` above (for non-Stripe sources and for `PipelineDetail`/`PipelineList` which call `inferGroupName(name)` directly without a full stream object). Add the two-word prefix check for `billing_portal_*` before the single-word lookup.

---

## Step 4 — Tests (`apps/dashboard/src/lib/stream-groups.test.ts`)

Add test cases for:

- `topup` → "Payments" (was "Topup")
- `quote` → "Billing" (was "Quote")
- `billing_portal_configuration` → "Billing Portal" (was "Billing")
- `terminal_readers` → "Terminal"
- `financial_connections_accounts` → "Financial Connections"
- Group ordering: Payments before Billing before Connect
- `stream.group` field takes priority over `inferGroupName`

---

## Verification

```sh
# Unit tests
cd apps/dashboard && pnpm test

# Full build (from monorepo root)
pnpm build

# Regenerate OpenAPI specs
./scripts/generate-openapi.sh

# Pre-push
pnpm format && pnpm lint && pnpm build
```
