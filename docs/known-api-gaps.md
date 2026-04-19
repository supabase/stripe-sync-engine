# Known Stripe API / OAS Spec Gaps

Endpoints where the OpenAPI spec doesn't match actual API behavior, causing
the sync engine to either skip or mishandle resources. File bugs upstream
when possible; in the meantime, work around them in the sync engine.

---

## 1. `GET /v1/billing/credit_balance_transactions` — customer is effectively required

**Spec says:** `customer` query param is `"required": false`
**Actual behavior:** Returns `400` without `customer` or `customer_account`:

```
Must provide customer or customer_account.
[GET /v1/billing/credit_balance_transactions (400)]
{request-id=req_LJckk6NlnteF5z}
```

**Impact:** The endpoint appears as a top-level listable resource in discovery,
but always fails at runtime. Currently worked around by adding it to
`EXCLUDED_TABLES` in `packages/source-stripe/src/resourceRegistry.ts`.

**API docs:** https://docs.stripe.com/api/billing/credit-balance-transaction/list

**Fix needed:** Mark `customer` (or `customer_account`) as `required: true` in the OAS spec.

---

## 2. `GET /v1/payment_methods` — top-level list returns 0 results

**Spec says:** All query params are optional; endpoint returns "a list of all PaymentMethods."
**Actual behavior:** Returns an empty list (`data: []`) even when the account has
503+ payment method objects retrievable by ID.

- `pm_` objects with `customer: null` (orphaned/never attached): individually
  retrievable via `GET /v1/payment_methods/:id` but never appear in any list endpoint.
- `src_` and `card_` objects attached to customers: only returned by the
  customer-scoped endpoint `GET /v1/customers/{customer}/payment_methods`.

**Impact:** Sync engine discovers `payment_methods` as a syncable top-level
resource but fetches 0 records. The reconcile script skips this table entirely.

**Fix needed:** Either:
- Make the top-level list endpoint actually return all payment methods, or
- Document that `customer` is effectively required and mark it in the spec.

**Workaround path:** Implement nested resource iteration
(`/v1/customers/{customer}/payment_methods`) to sync customer-attached payment
methods. The 503 orphaned `pm_` objects remain unreachable via list.
