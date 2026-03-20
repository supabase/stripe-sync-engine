import { createEngine } from '@stripe/sync-protocol'
import type { SyncParams, StateMessage, Message, ConnectorResolver } from '@stripe/sync-protocol'
import type {
  CredentialStore,
  ConfigStore,
  StateStore,
  LogSink,
  SyncConfig,
  Credential,
} from './stores'

// MARK: - Resolution

/** Merge stored config + credentials + state into engine-ready SyncParams. */
export function resolve(opts: {
  config: SyncConfig
  sourceCred: Credential
  destCred: Credential
  state?: Record<string, unknown>
}): SyncParams {
  // Strip `type` — it's a connector selector, not config data.
  const { type: sourceType, ...sourceRest } = opts.config.source
  const { type: destType, ...destRest } = opts.config.destination
  return {
    source: sourceType,
    destination: destType,
    source_config: { ...sourceRest, ...opts.sourceCred.fields },
    destination_config: { ...destRest, ...opts.destCred.fields },
    streams: opts.config.streams,
    state: opts.state,
  }
}

// MARK: - SyncService

export type SyncServiceOptions = {
  credentials: CredentialStore
  configs: ConfigStore
  states: StateStore
  logs: LogSink
  connectors: ConnectorResolver
  /** Called on auth_error to refresh a credential. If not provided, auth_error is not retried. */
  refreshCredential?: (credentialId: string) => Promise<void>
}

const MAX_AUTH_RETRIES = 2

export class SyncService {
  private credentials: CredentialStore
  private configs: ConfigStore
  private states: StateStore
  private logs: LogSink
  private connectors: ConnectorResolver
  private refreshCredential?: (credentialId: string) => Promise<void>

  constructor(opts: SyncServiceOptions) {
    this.credentials = opts.credentials
    this.configs = opts.configs
    this.states = opts.states
    this.logs = opts.logs
    this.connectors = opts.connectors
    this.refreshCredential = opts.refreshCredential
  }

  async *run(syncId: string): AsyncIterable<StateMessage> {
    const config = await this.configs.get(syncId)
    const source = await this.connectors.resolveSource(config.source.type)
    const destination = await this.connectors.resolveDestination(config.destination.type)

    let retries = 0

    while (retries <= MAX_AUTH_RETRIES) {
      // Load credentials fresh each attempt (may have been refreshed)
      const sourceCred = await this.credentials.get(config.source_credential_id)
      const destCred = await this.credentials.get(config.destination_credential_id)

      // Load state (picks up checkpoints from previous attempt)
      const state = await this.states.get(syncId)

      // Resolve to SyncParams
      const params = resolve({ config, sourceCred, destCred, state })

      // Create engine
      const engine = createEngine(params, { source, destination })
      await engine.setup()

      let authError = false

      // Read from source, intercepting auth_error before it reaches the destination
      const sourceMessages = engine.read()
      const intercepted = async function* (): AsyncIterable<Message> {
        for await (const msg of sourceMessages) {
          if (msg.type === 'error' && msg.failure_type === 'auth_error') {
            authError = true
            return
          }
          yield msg
        }
      }

      // Write intercepted messages through the destination
      for await (const msg of engine.write(intercepted())) {
        // Persist state checkpoint
        await this.states.set(syncId, msg.stream, msg.data)
        this.logs.write(syncId, {
          level: 'debug',
          message: `checkpoint: ${msg.stream}`,
          stream: msg.stream,
          timestamp: new Date().toISOString(),
        })
        yield msg
      }

      if (!authError) return // success

      // Attempt credential refresh
      if (this.refreshCredential) {
        this.logs.write(syncId, {
          level: 'warn',
          message: `auth_error — refreshing credential ${config.source_credential_id} (attempt ${retries + 1}/${MAX_AUTH_RETRIES})`,
          timestamp: new Date().toISOString(),
        })
        await this.refreshCredential(config.source_credential_id)
      } else {
        throw new Error(`auth_error on sync ${syncId} but no refreshCredential handler configured`)
      }

      retries++
    }

    throw new Error(`Auth failed after ${MAX_AUTH_RETRIES} refresh attempts for sync ${syncId}`)
  }
}
