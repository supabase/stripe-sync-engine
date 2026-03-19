# Stripe Sync — Scenarios

Scenarios that validate the Sync API layer — credential management, sync lifecycle, and multi-source/multi-destination configurations.

## Credential Scenarios

### Create and use a Postgres credential

```
POST /credentials  { type: "postgres", host: "...", port: 5432, ... }
  → cred_pg_abc123

POST /syncs  { source: { type: "stripe-api-core", ... }, destination: { type: "postgres", credential_id: "cred_pg_abc123", ... } }
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
POST /syncs        { source: { type: "stripe-api-core", credential_id: "cred_stripe_..." },
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

### Stripe → managed Stripe DB

The convenience flow: sync Stripe data into a Stripe-managed database.

```
POST /syncs  { source: { type: "stripe-api-core", credential_id: "cred_stripe_..." },
               destination: { type: "stripe-database", database_id: "db_abc123" } }
```

| Test                                                         | Validates               |
| ------------------------------------------------------------ | ----------------------- |
| No credential needed for destination (Stripe DB is internal) | Internal auth           |
| Sync targets the correct database by `database_id`           | Destination routing     |
| DB API shows this sync in its `syncs[]` enrichment           | Cross-layer integration |

### Stripe → Google Sheets

```
POST /syncs  { source: { type: "stripe-api-core", credential_id: "cred_stripe_..." },
               destination: { type: "google-sheets", google_sheet_id: "1abc...", credential_id: "cred_goog_..." } }
```

| Test                                               | Validates            |
| -------------------------------------------------- | -------------------- |
| Each stream creates a separate sheet tab           | Destination behavior |
| Records append as rows                             | Record writing       |
| Sync status reflects Google Sheets API rate limits | Status accuracy      |

## Multi-Sync Scenarios

### Two syncs targeting one Postgres database

```
Sync A: stripe-api-core      → postgres (schema: "stripe")
Sync B: stripe-api-reporting  → postgres (schema: "reporting")
Both target the same Postgres host with different schemas.
```

| Test                                              | Validates           |
| ------------------------------------------------- | ------------------- |
| Both syncs run independently with separate status | Independence        |
| Each writes to its own schema                     | Schema isolation    |
| Each has its own `Sync.state` checkpoint map      | State isolation     |
| Pausing Sync A does not affect Sync B             | Lifecycle isolation |

### Two syncs targeting one Stripe DB

```
Sync A: stripe-api-core      → stripe-database (db_abc123)
Sync B: stripe-api-reporting  → stripe-database (db_abc123)
```

| Test                                                  | Validates    |
| ----------------------------------------------------- | ------------ |
| DB API returns both syncs in `syncs[]` array          | Enrichment   |
| `stripe db list` shows "2 (1 syncing, 1 backfilling)" | CLI display  |
| Deleting Sync A leaves Sync B running                 | Independence |

### Zero syncs on a database

```
Create db_abc123 (creates default sync)
Delete the default sync
```

| Test                                         | Validates              |
| -------------------------------------------- | ---------------------- |
| Database still accessible for direct queries | DB independence        |
| `syncs[]` is empty in DB API response        | Enrichment correctness |
| `stripe db list` shows "—" in syncs column   | CLI display            |

## Files

| File              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `scenarios.md`    | This document                                                    |
| `ARCHITECTURE.md` | Sync resource, source types, destination types, status lifecycle |
| `sync-types.ts`   | Credential, Sync, SourceConfig, DestinationConfig                |
| `sync-api.ts`     | API route map                                                    |
