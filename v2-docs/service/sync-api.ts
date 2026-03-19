import type { Credential, CredentialConfig, Sync } from './sync-types'

// Sync Service — Route Map

interface ListResponse<T> {
  data: T[]
  has_more: boolean
}

export interface SyncAPI {
  // MARK: - Credentials

  /** List Credentials */
  'GET /credentials': { response: ListResponse<Credential> }
  /** Create Credential */
  'POST /credentials': { body: CredentialConfig; response: Credential }

  /** Retrieve Credential */
  'GET /credentials/:id': { response: Credential }
  /** Update Credential */
  'PATCH /credentials/:id': { body: Partial<CredentialConfig>; response: Credential }
  /** Delete Credential */
  'DELETE /credentials/:id': { response: { id: `cred_${string}`; deleted: true } }

  // MARK: - Syncs

  /** List Syncs */
  'GET /syncs': { response: ListResponse<Sync> }
  /** Create Sync */
  'POST /syncs': { body: Omit<Sync, 'id'>; response: Sync }

  /** Retrieve Sync */
  'GET /syncs/:id': { response: Sync }
  /** Update Sync */
  'PATCH /syncs/:id': { body: Partial<Omit<Sync, 'id'>>; response: Sync }
  /** Delete Sync */
  'DELETE /syncs/:id': { response: { id: `sync_${string}`; deleted: true } }
}
