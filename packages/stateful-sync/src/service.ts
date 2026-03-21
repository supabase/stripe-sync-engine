import { createEngine } from '@stripe/stateless-sync'
import type {
  SyncParams,
  StateMessage,
  Message,
  ConnectorResolver,
  CheckResult,
} from '@stripe/stateless-sync'
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
  sourceOverrides?: Record<string, unknown>
  destinationOverrides?: Record<string, unknown>
}): SyncParams {
  // Strip connector-selector fields — `type` and `credential_id` are not config data.
  const sourceType = opts.config.source.type
  const destType = opts.config.destination.type
  const sourceRest = Object.fromEntries(
    Object.entries(opts.config.source).filter(([k]) => k !== 'type' && k !== 'credential_id')
  )
  const destRest = Object.fromEntries(
    Object.entries(opts.config.destination).filter(([k]) => k !== 'type' && k !== 'credential_id')
  )
  // Strip credential metadata — only type-specific fields belong in config.
  const credMeta = new Set(['id', 'type', 'created_at', 'updated_at'])
  const srcCredFields = Object.fromEntries(
    Object.entries(opts.sourceCred as Record<string, unknown>).filter(([k]) => !credMeta.has(k))
  )
  const dstCredFields = Object.fromEntries(
    Object.entries(opts.destCred as Record<string, unknown>).filter(([k]) => !credMeta.has(k))
  )
  return {
    source_name: sourceType,
    destination_name: destType,
    source_config: { ...sourceRest, ...srcCredFields, ...opts.sourceOverrides },
    destination_config: { ...destRest, ...dstCredFields, ...opts.destinationOverrides },
    streams: opts.config.streams,
    state: opts.state,
  }
}

// MARK: - StatefulSync

export type StatefulSyncOptions = {
  credentials: CredentialStore
  configs: ConfigStore
  states: StateStore
  logs: LogSink
  connectors: ConnectorResolver
  /** Called on auth_error to refresh a credential. If not provided, auth_error is not retried. */
  refreshCredential?: (credentialId: string) => Promise<void>
  /** Extra config fields merged on top of source credential (env vars, CLI flags). */
  sourceOverrides?: Record<string, unknown>
  /** Extra config fields merged on top of destination credential (env vars, CLI flags). */
  destinationOverrides?: Record<string, unknown>
}

const MAX_AUTH_RETRIES = 2

export class StatefulSync {
  private credentials: CredentialStore
  private configs: ConfigStore
  private states: StateStore
  private logs: LogSink
  private connectors: ConnectorResolver
  private refreshCredential?: (credentialId: string) => Promise<void>
  private sourceOverrides?: Record<string, unknown>
  private destinationOverrides?: Record<string, unknown>

  constructor(opts: StatefulSyncOptions) {
    this.credentials = opts.credentials
    this.configs = opts.configs
    this.states = opts.states
    this.logs = opts.logs
    this.connectors = opts.connectors
    this.refreshCredential = opts.refreshCredential
    this.sourceOverrides = opts.sourceOverrides
    this.destinationOverrides = opts.destinationOverrides
  }

  /** Resolve config + credentials + state into an engine instance. */
  private async resolveEngine(syncId: string) {
    const config = await this.configs.get(syncId)
    const source = await this.connectors.resolveSource(config.source.type)
    const destination = await this.connectors.resolveDestination(config.destination.type)
    const sourceCred = await this.credentials.get(config.source.credential_id)
    const destCred = await this.credentials.get(config.destination.credential_id)
    const state = await this.states.get(syncId)
    const params = resolve({
      config,
      sourceCred,
      destCred,
      state,
      sourceOverrides: this.sourceOverrides,
      destinationOverrides: this.destinationOverrides,
    })
    const engine = createEngine(params, { source, destination })
    return { engine, config }
  }

  async setup(syncId: string): Promise<void> {
    const { engine } = await this.resolveEngine(syncId)
    await engine.setup()
  }

  async teardown(syncId: string): Promise<void> {
    const { engine } = await this.resolveEngine(syncId)
    await engine.teardown()
  }

  async check(syncId: string): Promise<{ source: CheckResult; destination: CheckResult }> {
    const { engine } = await this.resolveEngine(syncId)
    return engine.check()
  }

  async *read(syncId: string, $stdin?: AsyncIterable<unknown>): AsyncIterable<Message> {
    const { engine } = await this.resolveEngine(syncId)
    yield* engine.read($stdin)
  }

  async *write(syncId: string, messages: AsyncIterable<Message>): AsyncIterable<StateMessage> {
    const { engine } = await this.resolveEngine(syncId)
    for await (const msg of engine.write(messages)) {
      await this.states.set(syncId, msg.stream, msg.data)
      this.logs.write(syncId, {
        level: 'debug',
        message: `checkpoint: ${msg.stream}`,
        stream: msg.stream,
        timestamp: new Date().toISOString(),
      })
      yield msg
    }
  }

  async *run(syncId: string, $stdin?: AsyncIterable<unknown>): AsyncIterable<StateMessage> {
    const config = await this.configs.get(syncId)
    const source = await this.connectors.resolveSource(config.source.type)
    const destination = await this.connectors.resolveDestination(config.destination.type)

    let retries = 0

    while (retries <= MAX_AUTH_RETRIES) {
      // Load credentials fresh each attempt (may have been refreshed)
      const sourceCred = await this.credentials.get(config.source.credential_id)
      const destCred = await this.credentials.get(config.destination.credential_id)

      // Load state (picks up checkpoints from previous attempt)
      const state = await this.states.get(syncId)

      // Resolve to SyncParams
      const params = resolve({
        config,
        sourceCred,
        destCred,
        state,
        sourceOverrides: this.sourceOverrides,
        destinationOverrides: this.destinationOverrides,
      })

      // Create engine
      const engine = createEngine(params, { source, destination })
      await engine.setup()

      let authError = false

      // Read from source, intercepting auth_error before it reaches the destination
      const sourceMessages = engine.read($stdin)
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
          message: `auth_error — refreshing credential ${config.source.credential_id} (attempt ${retries + 1}/${MAX_AUTH_RETRIES})`,
          timestamp: new Date().toISOString(),
        })
        await this.refreshCredential(config.source.credential_id)
      } else {
        throw new Error(`auth_error on sync ${syncId} but no refreshCredential handler configured`)
      }

      retries++
    }

    throw new Error(`Auth failed after ${MAX_AUTH_RETRIES} refresh attempts for sync ${syncId}`)
  }
}
