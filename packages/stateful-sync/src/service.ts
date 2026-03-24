import { createEngine } from '@tx-stripe/stateless-sync'
import type {
  SyncParams,
  StateMessage,
  Message,
  ConnectorResolver,
  CheckResult,
} from '@tx-stripe/stateless-sync'
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
  sourceCred?: Credential
  destCred?: Credential
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
  const srcCredFields = opts.sourceCred
    ? Object.fromEntries(
        Object.entries(opts.sourceCred as Record<string, unknown>).filter(([k]) => !credMeta.has(k))
      )
    : {}
  const dstCredFields = opts.destCred
    ? Object.fromEntries(
        Object.entries(opts.destCred as Record<string, unknown>).filter(([k]) => !credMeta.has(k))
      )
    : {}
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

/** Minimal async queue — push values in, iterate them out. */
function createAsyncQueue<T>() {
  const buffer: T[] = []
  let pending: ((result: IteratorResult<T, undefined>) => void) | null = null

  function push(value: T) {
    if (pending) {
      const resolve = pending
      pending = null
      resolve({ value, done: false })
    } else {
      buffer.push(value)
    }
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false as const })
          }
          return new Promise((resolve) => {
            pending = resolve
          })
        },
      }
    },
  }

  return { push, iterable }
}

export class StatefulSync {
  private credentials: CredentialStore
  private configs: ConfigStore
  private states: StateStore
  private logs: LogSink
  private connectors: ConnectorResolver
  private refreshCredential?: (credentialId: string) => Promise<void>
  private sourceOverrides?: Record<string, unknown>
  private destinationOverrides?: Record<string, unknown>
  /** Registry of active input queues keyed by credential_id. */
  private inputQueues: Map<string, Set<(event: unknown) => void>> = new Map()

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
    const sourceCred = config.source.credential_id
      ? await this.credentials.get(config.source.credential_id)
      : undefined
    const destCred = config.destination.credential_id
      ? await this.credentials.get(config.destination.credential_id)
      : undefined
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

  /**
   * Push an event to all running syncs that share the given credential.
   * Each sync verifies the event independently via its own webhook secret.
   */
  push_event(credential_id: string, event: unknown): void {
    const queues = this.inputQueues.get(credential_id)
    if (!queues) return
    for (const push of queues) {
      push(event)
    }
  }

  async setup(syncId: string): Promise<void> {
    const { engine } = await this.resolveEngine(syncId)
    await engine.setup()
  }

  async teardown(syncId: string): Promise<void> {
    const { engine, config } = await this.resolveEngine(syncId)
    // Only tear down shared resources (e.g. webhook endpoint) if no other
    // syncs share this credential — otherwise just do per-sync cleanup.
    const credId = config.source.credential_id
    let remove_shared_resources = true
    if (credId) {
      const allSyncs = await this.configs.list()
      const otherSyncs = allSyncs.filter(
        (s) => s.id !== syncId && s.source.credential_id === credId
      )
      remove_shared_resources = otherSyncs.length === 0
    }
    await engine.teardown({ remove_shared_resources })
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

    // If no external $stdin and the sync has a credential, register an internal
    // input queue so push_event() can fan out webhook events to this sync.
    const credId = config.source.credential_id
    let activeStdin = $stdin
    let queuePush: ((event: unknown) => void) | undefined

    if (!$stdin && credId) {
      const queue = createAsyncQueue<unknown>()
      queuePush = queue.push
      activeStdin = queue.iterable
      if (!this.inputQueues.has(credId)) {
        this.inputQueues.set(credId, new Set())
      }
      this.inputQueues.get(credId)!.add(queuePush)
    }

    let retries = 0

    try {
      while (retries <= MAX_AUTH_RETRIES) {
        // Load credentials fresh each attempt (may have been refreshed)
        const sourceCred = config.source.credential_id
          ? await this.credentials.get(config.source.credential_id)
          : undefined
        const destCred = config.destination.credential_id
          ? await this.credentials.get(config.destination.credential_id)
          : undefined

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
        const sourceMessages = engine.read(activeStdin)
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
        if (!config.source.credential_id) {
          throw new Error(`auth_error on sync ${syncId} but source has no credential_id to refresh`)
        }
        if (this.refreshCredential) {
          this.logs.write(syncId, {
            level: 'warn',
            message: `auth_error — refreshing credential ${config.source.credential_id} (attempt ${retries + 1}/${MAX_AUTH_RETRIES})`,
            timestamp: new Date().toISOString(),
          })
          await this.refreshCredential(config.source.credential_id)
        } else {
          throw new Error(
            `auth_error on sync ${syncId} but no refreshCredential handler configured`
          )
        }

        retries++
      }

      throw new Error(`Auth failed after ${MAX_AUTH_RETRIES} refresh attempts for sync ${syncId}`)
    } finally {
      // Deregister the internal input queue when this sync stops running
      if (queuePush && credId) {
        this.inputQueues.get(credId)?.delete(queuePush)
        if (this.inputQueues.get(credId)?.size === 0) {
          this.inputQueues.delete(credId)
        }
      }
    }
  }
}
