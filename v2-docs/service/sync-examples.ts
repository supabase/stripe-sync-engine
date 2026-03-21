import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Credential, CredentialConfig, Sync } from './sync-types'

// MARK: - Credentials

export const cred_stripe_prod = {
  id: 'cred_stripe_prod',
  account_id: 'acct_abc123',
  type: 'stripe',
  api_key: 'sk_live_abc123',
} satisfies Credential

export const cred_pg_prod = {
  id: 'cred_pg_prod',
  account_id: 'acct_abc123',
  type: 'postgres',
  host: 'db.example.com',
  port: 5432,
  user: 'stripe_sync',
  password: 'secretpassword',
  database: 'stripe',
} satisfies Credential

export const cred_google_finance = {
  id: 'cred_google_finance',
  account_id: 'acct_abc123',
  type: 'google',
  client_id: '123456.apps.googleusercontent.com',
  client_secret: 'GOCSPX-abc123',
  refresh_token: '1//0abc123',
} satisfies Credential

// MARK: - Stripe → Postgres

export const sync_stripe_to_pg = {
  id: 'sync_stripe_to_pg',
  account_id: 'acct_abc123',
  source: {
    type: 'stripe-api-core',
    api_version: '2025-04-30.basil',
    credential_id: 'cred_stripe_prod',
  },
  destination: {
    type: 'postgres',
    schema_name: 'stripe_sync',
    credential_id: 'cred_pg_prod',
  },
} satisfies Sync

// MARK: - Stripe → Google Sheets

export const sync_stripe_to_sheets = {
  id: 'sync_stripe_to_sheets',
  account_id: 'acct_abc123',
  source: {
    type: 'stripe-api-core',
    api_version: '2025-04-30.basil',
    credential_id: 'cred_stripe_prod',
  },
  destination: {
    type: 'google-sheets',
    google_sheet_id: '1ABCdef_spreadsheet_id',
    credential_id: 'cred_google_finance',
  },
} satisfies Sync

// MARK: - Sync Service (simplest SyncAPI implementation)
//
// In-memory store backed by a JSON file. No database, no HTTP server.
//
// Usage:
//   alias svc='npx tsx packages/ts-cli/src/index.ts ./docs-architecture/sync/sync-examples'
//   svc credentials list
//   svc credentials create '{"type":"stripe","api_key":"sk_test_123"}'
//   svc syncs list
//   svc syncs create '{"account_id":"acct_1","status":"backfilling","source":{...},"destination":{...}}'
//   svc syncs get sync_abc123

const STORE_PATH = join(process.cwd(), 'sync-store.json')

interface Store {
  credentials: Record<string, Credential>
  syncs: Record<string, Sync>
}

function load(): Store {
  if (!existsSync(STORE_PATH)) return { credentials: {}, syncs: {} }
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
}

function save(store: Store): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2) + '\n')
}

let counter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(counter++).toString(36)}`
}

export const credentials = {
  list() {
    return { data: Object.values(load().credentials), has_more: false }
  },
  create(config: CredentialConfig) {
    const store = load()
    const cred: Credential = {
      id: genId('cred') as `cred_${string}`,
      account_id: 'acct_default' as `acct_${string}`,
      ...config,
    }
    store.credentials[cred.id] = cred
    save(store)
    return cred
  },
  get(id: string) {
    const cred = load().credentials[id]
    if (!cred) throw new Error(`Credential ${id} not found`)
    return cred
  },
  update(id: string, patch: Partial<CredentialConfig>) {
    const store = load()
    const cred = store.credentials[id]
    if (!cred) throw new Error(`Credential ${id} not found`)
    Object.assign(cred, patch)
    save(store)
    return cred
  },
  delete(id: string) {
    const store = load()
    delete store.credentials[id]
    save(store)
    return { id: id as `cred_${string}`, deleted: true as const }
  },
}

export const syncs = {
  list() {
    return { data: Object.values(load().syncs), has_more: false }
  },
  create(body: Omit<Sync, 'id'>) {
    const store = load()
    const sync: Sync = { id: genId('sync') as `sync_${string}`, ...body }
    store.syncs[sync.id] = sync
    save(store)
    return sync
  },
  get(id: string) {
    const sync = load().syncs[id]
    if (!sync) throw new Error(`Sync ${id} not found`)
    return sync
  },
  update(id: string, patch: Partial<Omit<Sync, 'id'>>) {
    const store = load()
    const sync = store.syncs[id]
    if (!sync) throw new Error(`Sync ${id} not found`)
    Object.assign(sync, patch)
    save(store)
    return sync
  },
  delete(id: string) {
    const store = load()
    delete store.syncs[id]
    save(store)
    return { id: id as `sync_${string}`, deleted: true as const }
  },
}
