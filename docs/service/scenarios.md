# Stripe Sync — Scenarios

Scenarios that validate the Sync API layer — credential management, sync lifecycle, and multi-source/multi-destination configurations.

## Credential Scenarios

### Create and use a Postgres credential

```
POST /credentials  { type: "postgres", host: "...", port: 5432, ... }
  → cred_pg_abc123

POST /syncs  { source: { type: "stripe", ... }, destination: { type: "postgres", credential_id: "cred_pg_abc123", ... } }
  → sync starts, destination connects using the credential
```

| Test                                                                                    | Validates             |
| --------------------------------------------------------------------------------------- | --------------------- |
| Create credential returns `cred_*` ID                                                   | CRUD                  |
| Credential password is stored securely (not returned in list/retrieve after creation)   | Secret handling       |
| Sync with valid credential connects successfully                                        | Credential resolution |
| Sync with deleted credential fails with `config_error`                                  | Lifecycle             |
| Update credential (rotate password) propagates to running sync on restart               | Update flow           |
| Delete credential that's referenced by an active sync returns `credential_in_use` error | Referential integrity |

### Create and use a Google credential (OAuth)

```
POST /credentials  { type: "google", client_id: "...", client_secret: "...", refresh_token: "..." }
  → cred_goog_xyz789
```

| Test                                                         | Validates         |
| ------------------------------------------------------------ | ----------------- |
| OAuth refresh token is used to obtain access tokens          | Token flow        |
| Expired access token triggers refresh automatically          | Token refresh     |
| Revoked refresh token surfaces as `config_error` on the sync | Error propagation |

## Sync Lifecycle Scenarios

### Stripe → external Postgres

The standard flow: sync Stripe data into the user's own Postgres.

```
POST /credentials  { type: "stripe", api_key: "sk_test_..." }
POST /credentials  { type: "postgres", host: "user-db.example.com", ... }
POST /syncs        { source: { type: "stripe", credential_id: "cred_stripe_..." },
                     destination: { type: "postgres", schema_name: "stripe", credential_id: "cred_pg_..." } }
```

| Test                                                                                           | Validates        |
| ---------------------------------------------------------------------------------------------- | ---------------- |
| Sync status starts as `backfilling`                                                            | Initial state    |
| Sync transitions to `syncing` after backfill completes                                         | Lifecycle        |
| `GET /syncs/:id` returns current status + state                                                | Retrieval        |
| `PATCH /syncs/:id` with `status: "paused"` pauses the sync                                     | Pause            |
| `PATCH /syncs/:id` with `status: "syncing"` resumes from checkpoint                            | Resume           |
| `DELETE /syncs/:id` stops the pipeline and cleans up                                           | Deletion         |
| Sync with `streams: [{ name: "customers" }, { name: "invoices" }]` only syncs those streams    | Stream selection |
| Sync with `streams: [{ name: "charges", skip_backfill: true }]` skips backfill for that stream | Skip backfill    |

### Stripe → Google Sheets

```
POST /syncs  { source: { type: "stripe", credential_id: "cred_stripe_..." },
               destination: { type: "google_sheets", google_sheet_id: "1abc...", credential_id: "cred_goog_..." } }
```

| Test                                               | Validates            |
| -------------------------------------------------- | -------------------- |
| Each stream creates a separate sheet tab           | Destination behavior |
| Records append as rows                             | Record writing       |
| Sync status reflects Google Sheets API rate limits | Status accuracy      |

## Multi-Sync Scenarios

### Two syncs targeting one Postgres database

```
Sync A: stripe  → postgres (schema: "stripe")
Sync B: stripe  → postgres (schema: "reporting")
Both target the same Postgres host with different schemas.
```

| Test                                              | Validates           |
| ------------------------------------------------- | ------------------- |
| Both syncs run independently with separate status | Independence        |
| Each writes to its own schema                     | Schema isolation    |
| Each has its own `Sync.state` checkpoint map      | State isolation     |
| Pausing Sync A does not affect Sync B             | Lifecycle isolation |

## Files

| File                                | Description                                          |
| ----------------------------------- | ---------------------------------------------------- |
| `scenarios.md`                      | This document                                        |
| `ARCHITECTURE.md`                   | System layers, core model, source/destination types  |
| `packages/protocol/src/protocol.ts` | Source, Destination interfaces; message types        |
| `apps/service/src/lib/service.ts`   | `StatefulSync` class — credential + state management |
