import type { Credential, CredentialStore, SyncConfig, ConfigStore } from '../stores'

/**
 * Credential store backed by environment variables.
 * Reads STRIPE_API_KEY and DATABASE_URL (or custom env var names).
 * CLI-oriented — one source credential, one destination credential.
 */
export function envCredentialStore(opts?: {
  sourceEnvVar?: string
  destEnvVar?: string
}): CredentialStore {
  const sourceVar = opts?.sourceEnvVar ?? 'STRIPE_API_KEY'
  const destVar = opts?.destEnvVar ?? 'DATABASE_URL'

  function readCred(id: string): Credential {
    if (id === 'source' || id === 'env_source') {
      const value = process.env[sourceVar]
      if (!value) throw new Error(`${sourceVar} not set`)
      return {
        id: 'env_source',
        type: 'stripe',
        api_key: value,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    }
    if (id === 'destination' || id === 'env_destination') {
      const value = process.env[destVar]
      if (!value) throw new Error(`${destVar} not set`)
      return {
        id: 'env_destination',
        type: 'postgres',
        connection_string: value,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    }
    throw new Error(`envCredentialStore: unknown credential id "${id}"`)
  }

  return {
    async get(id) {
      return readCred(id)
    },
    async set() {
      throw new Error('envCredentialStore is read-only')
    },
    async delete() {
      throw new Error('envCredentialStore is read-only')
    },
    async list() {
      const creds: Credential[] = []
      try {
        creds.push(readCred('env_source'))
      } catch {}
      try {
        creds.push(readCred('env_destination'))
      } catch {}
      return creds
    },
  }
}

/**
 * Config store built from explicit values (e.g. CLI flags).
 * Holds a single sync config. Useful for CLI wiring.
 */
export function flagConfigStore(config: SyncConfig): ConfigStore {
  return {
    async get(id) {
      if (id !== config.id)
        throw new Error(`flagConfigStore: only has config "${config.id}", not "${id}"`)
      return config
    },
    async set() {
      throw new Error('flagConfigStore is read-only')
    },
    async delete() {
      throw new Error('flagConfigStore is read-only')
    },
    async list() {
      return [config]
    },
  }
}
