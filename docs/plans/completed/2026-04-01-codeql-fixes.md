# CodeQL Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve all 7 CodeQL alerts on PR #219 — 2 hash alerts and 5 ReDoS alerts.

**Architecture:** Three real fixes (dead code deletion, account-ID rate limiting, regex → includes) and one suppression (ts-cli path regex on trusted input). No new abstractions.

**Tech Stack:** TypeScript, Node.js crypto, Stripe SDK (`stripe` npm package), `@stripe/sync-source-stripe`

---

### Task 1: Delete dead code `hashApiKey.ts`

**Files:**

- Delete: `packages/source-stripe/src/utils/hashApiKey.ts`
- Check: `packages/source-stripe/src/index.ts` (confirm no import)

**Step 1: Verify nothing imports it**

```bash
grep -r "hashApiKey" packages/ apps/ --include="*.ts" | grep -v "hashApiKey.ts" | grep -v "dist/"
```

Expected: no output.

**Step 2: Delete the file**

```bash
git rm packages/source-stripe/src/utils/hashApiKey.ts
```

**Step 3: Build to confirm nothing breaks**

```bash
pnpm build
```

Expected: no errors.

**Step 4: Commit**

```bash
git commit -m "chore(source-stripe): remove unused hashApiKey utility"
```

---

### Task 2: Fix rate limiter bucket key — use account ID instead of API key hash

The current `createPgRateLimiter` in `apps/engine/src/api/app.ts` derives a bucket key by SHA-256-hashing the API key. This is wrong: Stripe rate limits are per account, not per key. Multiple restricted keys on the same account would each get their own bucket, effectively multiplying the rate limit. Fix: call `GET /v1/account` once at setup time and use the account ID directly.

**Files:**

- Modify: `apps/engine/src/api/app.ts`
- Modify: `packages/source-stripe/src/index.ts` (export `fetchAccountId` helper)
- Modify: `packages/source-stripe/src/index.ts` exports barrel

**Step 1: Add `fetchAccountId` to source-stripe**

In `packages/source-stripe/src/index.ts`, add after the existing exports near the top:

```typescript
/**
 * Fetch the Stripe account ID for a given API key config.
 * Used by the engine to key rate-limiter buckets by account, not by key.
 */
export async function fetchAccountId(
  config: Pick<Config, 'api_key' | 'base_url'>
): Promise<string> {
  const s = makeClient(config as Config)
  const account = await s.accounts.retrieve()
  return account.id
}
```

**Step 2: Run the build to verify the export compiles**

```bash
pnpm build
```

Expected: no errors.

**Step 3: Update `createPgRateLimiter` in `apps/engine/src/api/app.ts`**

Change the import at the top to include `fetchAccountId`:

```typescript
import { createStripeSource, DEFAULT_MAX_RPS, fetchAccountId } from '@stripe/sync-source-stripe'
```

Replace the bucket-key derivation:

```typescript
// Before:
const apiKey = srcConfig.api_key as string
const maxRps = (srcConfig.rate_limit as number | undefined) ?? DEFAULT_MAX_RPS
const keyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
const opts = { key: `stripe:${keyHash}`, max_rps: maxRps, schema }

// After:
const maxRps = (srcConfig.rate_limit as number | undefined) ?? DEFAULT_MAX_RPS
const accountId = await fetchAccountId(srcConfig as { api_key: string; base_url?: string })
const opts = { key: `stripe:${accountId}`, max_rps: maxRps, schema }
```

Also remove the `createHash` import from `node:crypto` if it's now unused:

```typescript
// Remove this line if createHash is no longer referenced elsewhere in app.ts:
import { createHash } from 'node:crypto'
```

**Step 4: Build and verify**

```bash
pnpm build
```

Expected: no errors. If `createHash` import is flagged as unused by TypeScript, remove it.

**Step 5: Commit**

```bash
git add apps/engine/src/api/app.ts packages/source-stripe/src/index.ts
git commit -m "fix(engine): rate-limit by Stripe account ID, not API key hash"
```

---

### Task 3: Fix ReDoS — replace regexes with `.includes()` in exec files

The patterns `/unknown command.*setup/i` and `/unknown command.*teardown/i` in `source-exec.ts` and `destination-exec.ts` use `.*` between two fixed strings, which CodeQL flags as potentially quadratic on adversarial input. Replace with plain string checks.

**Files:**

- Modify: `apps/engine/src/lib/source-exec.ts`
- Modify: `apps/engine/src/lib/destination-exec.ts`

**Step 1: Update `source-exec.ts`**

There are two occurrences. Replace both:

```typescript
// Before:
if (/unknown command.*setup/i.test(String(err))) return
// After:
if (
  String(err).toLowerCase().includes('unknown command') &&
  String(err).toLowerCase().includes('setup')
)
  return
```

```typescript
// Before:
if (/unknown command.*teardown/i.test(String(err))) return
// After:
if (
  String(err).toLowerCase().includes('unknown command') &&
  String(err).toLowerCase().includes('teardown')
)
  return
```

**Step 2: Update `destination-exec.ts`**

Same two replacements (identical patterns):

```typescript
// Before:
if (/unknown command.*setup/i.test(String(err))) return
// After:
if (
  String(err).toLowerCase().includes('unknown command') &&
  String(err).toLowerCase().includes('setup')
)
  return
```

```typescript
// Before:
if (/unknown command.*teardown/i.test(String(err))) return
// After:
if (
  String(err).toLowerCase().includes('unknown command') &&
  String(err).toLowerCase().includes('teardown')
)
  return
```

**Step 3: Run tests**

```bash
pnpm test
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add apps/engine/src/lib/source-exec.ts apps/engine/src/lib/destination-exec.ts
git commit -m "fix(engine): replace ReDoS-flagged regexes with includes() in exec helpers"
```

---

### Task 4: Suppress ReDoS in `ts-cli/src/openapi/parse.ts`

The `\{[^}]+\}` pattern (removes path params like `{id}`) is flagged. The input is OpenAPI spec path strings — they come from trusted spec files, not attacker-controlled input. A CLI tool user already has code execution on the machine. Suppress with a comment rather than rewriting the pattern.

**Files:**

- Modify: `packages/ts-cli/src/openapi/parse.ts`

**Step 1: Add suppression comment**

Find the block (around line 96–99):

```typescript
const cleaned = path
  .replace(/\{[^}]+\}/g, '') // remove path params  // codeql-suppress[js/redos] -- input is OpenAPI spec path strings from trusted files, not attacker-controlled
  .replace(/\/+/g, '-')
  .replace(/^-+|-+$/g, '')
  .replace(/-+/g, '-')
```

The comment must be on the same line as the flagged pattern or the line immediately above it. Place it inline:

```typescript
const cleaned = path
  .replace(/\{[^}]+\}/g, '') // codeql[js/redos] input is OpenAPI spec path from a trusted file
  .replace(/\/+/g, '-') // slashes to dashes
  .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
  .replace(/-+/g, '-') // collapse multiple dashes
```

**Step 2: Build**

```bash
pnpm build
```

Expected: no errors.

**Step 3: Commit**

```bash
git add packages/ts-cli/src/openapi/parse.ts
git commit -m "chore(ts-cli): suppress CodeQL ReDoS false positive on path-param regex"
```

---

## Verification

After all four tasks, push and confirm the CodeQL check on PR #219 goes green:

```bash
git push
```

Then monitor: `gh pr checks 219 --repo stripe/sync-engine --watch`
