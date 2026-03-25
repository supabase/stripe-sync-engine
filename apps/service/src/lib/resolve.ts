import type { SyncParams } from '@stripe/sync-engine'
import type { Credential, SyncConfig } from './schemas.js'

/** Fields that are credential metadata, not connector config. */
const CREDENTIAL_META = new Set(['id', 'type', 'created_at', 'updated_at'])

/** Strip selector fields (type, credential_id) from a config section. */
function stripSelectorFields(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => k !== 'type' && k !== 'credential_id')
  )
}

/** Strip metadata fields from a credential, leaving only connector-specific fields. */
function stripCredentialMeta(cred: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(cred).filter(([k]) => !CREDENTIAL_META.has(k)))
}

/**
 * Merge stored config + credentials + state into engine-ready SyncParams.
 *
 * Priority (highest → lowest): inline config fields > credential fields.
 * Credential metadata (id, type, timestamps) is stripped — only connector-specific
 * fields (api_key, connection_string, etc.) are merged.
 */
export function resolve(opts: {
  config: SyncConfig
  sourceCred?: Credential
  destCred?: Credential
  state?: Record<string, unknown>
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): SyncParams {
  const sourceType = opts.config.source.type
  const destType = opts.config.destination.type

  const sourceRest = stripSelectorFields(opts.config.source)
  const destRest = stripSelectorFields(opts.config.destination)

  const srcCredFields = opts.sourceCred
    ? stripCredentialMeta(opts.sourceCred as Record<string, unknown>)
    : {}
  const dstCredFields = opts.destCred
    ? stripCredentialMeta(opts.destCred as Record<string, unknown>)
    : {}

  return {
    source_name: sourceType,
    destination_name: destType,
    source_config: { ...srcCredFields, ...sourceRest, ...opts.sourceOverrides },
    destination_config: { ...dstCredFields, ...destRest, ...opts.destinationOverrides },
    streams: opts.config.streams,
    state: opts.state,
  }
}
