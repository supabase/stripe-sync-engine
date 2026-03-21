import type { Credential, SyncConfig } from '@stripe/stateful-sync'

// ── ID generation ────────────────────────────────────────────────

let counter = Date.now()
export function genId(prefix: string): string {
  return `${prefix}_${(counter++).toString(36)}`
}

// ── Credential adapters ──────────────────────────────────────────

/** Convert flat API credential config to store shape. */
export function credentialToStore(id: string, apiCred: Record<string, unknown>): Credential {
  const { type, ...fields } = apiCred
  const now = new Date().toISOString()
  return { id, type: type as string, fields, created_at: now, updated_at: now }
}

/** Convert store credential to flat API shape. */
export function credentialToApi(storeCred: Credential): Record<string, unknown> {
  return {
    id: storeCred.id,
    account_id: 'acct_default',
    type: storeCred.type,
    ...storeCred.fields,
  }
}

// ── Sync adapters ────────────────────────────────────────────────

/** Convert API sync shape to store config. */
export function syncToStoreConfig(id: string, apiSync: Record<string, unknown>): SyncConfig {
  const source = apiSync.source as Record<string, unknown>
  const destination = apiSync.destination as Record<string, unknown>
  const { credential_id: source_credential_id, ...sourceRest } = source as any
  const { credential_id: destination_credential_id, ...destRest } = destination as any
  return {
    id,
    account_id: apiSync.account_id as string | undefined,
    status: apiSync.status as string | undefined,
    source_credential_id: source_credential_id ?? '',
    destination_credential_id: destination_credential_id ?? '',
    source: sourceRest,
    destination: destRest,
    streams: apiSync.streams as SyncConfig['streams'],
  }
}

/** Convert store config to API sync shape. */
export function storeConfigToSync(config: SyncConfig): Record<string, unknown> {
  return {
    id: config.id,
    account_id: config.account_id,
    status: config.status,
    source: { ...config.source, credential_id: config.source_credential_id },
    destination: { ...config.destination, credential_id: config.destination_credential_id },
    streams: config.streams,
  }
}
