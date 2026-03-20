import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Store directory (resolved lazily so tests can set STORE_DIR) ─

function storeDir() {
  const dir = process.env.STORE_DIR || join(process.cwd(), '.stripe-sync')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function credPath() {
  return join(storeDir(), 'credentials.json')
}
function syncPath() {
  return join(storeDir(), 'syncs.json')
}

// ── Helpers ─────────────────────────────────────────────────────

function loadJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function saveJson(path: string, data: Record<string, any>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

let counter = Date.now()
function genId(prefix: string): string {
  return `${prefix}_${(counter++).toString(36)}`
}

// ── Credentials ─────────────────────────────────────────────────

export const credentials = {
  list() {
    return { data: Object.values(loadJson(credPath())), has_more: false }
  },

  create(config: any) {
    const path = credPath()
    const store = loadJson(path)
    const cred = { id: genId('cred'), account_id: 'acct_default', ...config }
    store[cred.id] = cred
    saveJson(path, store)
    return cred
  },

  get(id: string) {
    return loadJson(credPath())[id] ?? null
  },

  update(id: string, patch: any) {
    const path = credPath()
    const store = loadJson(path)
    const cred = store[id]
    if (!cred) return null
    Object.assign(cred, patch)
    saveJson(path, store)
    return cred
  },

  delete(id: string) {
    const path = credPath()
    const store = loadJson(path)
    if (!store[id]) return null
    delete store[id]
    saveJson(path, store)
    return { id, deleted: true as const }
  },
}

// ── Syncs ───────────────────────────────────────────────────────

export const syncs = {
  list() {
    return { data: Object.values(loadJson(syncPath())), has_more: false }
  },

  create(body: any) {
    const path = syncPath()
    const store = loadJson(path)
    const sync = { id: genId('sync'), ...body }
    store[sync.id] = sync
    saveJson(path, store)
    return sync
  },

  get(id: string) {
    return loadJson(syncPath())[id] ?? null
  },

  update(id: string, patch: any) {
    const path = syncPath()
    const store = loadJson(path)
    const sync = store[id]
    if (!sync) return null
    Object.assign(sync, patch)
    saveJson(path, store)
    return sync
  },

  delete(id: string) {
    const path = syncPath()
    const store = loadJson(path)
    if (!store[id]) return null
    delete store[id]
    saveJson(path, store)
    return { id, deleted: true as const }
  },
}
