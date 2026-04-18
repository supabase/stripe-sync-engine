import type {
  CatalogMessage,
  ConnectionStatusMessage,
  ConnectionStatusPayload,
  ControlMessage,
  ControlPayload,
  DestinationInput,
  EofMessage,
  EofPayload,
  GlobalStatePayload,
  LogMessage,
  LogPayload,
  Message,
  ProgressMessage,
  ProgressPayload,
  RecordMessage,
  RecordPayload,
  SectionState,
  SourceStateMessage,
  SpecMessage,
  StreamStatusMessage,
  StreamStatusPayload,
  StreamStatePayload,
  SyncState,
} from './protocol.js'

// MARK: - Message constructors

/** Wrap a raw object into an envelope RecordMessage. */
export function toRecordMessage(stream: string, data: Record<string, unknown>): RecordMessage {
  return {
    type: 'record',
    record: {
      stream,
      data,
      emitted_at: new Date().toISOString(),
    },
  }
}

/** Extract the raw data from a RecordMessage. */
export function fromRecordMessage(msg: RecordMessage): Record<string, unknown> {
  return msg.record.data as Record<string, unknown>
}

/** Extract the stream name from a RecordMessage. */
export function recordStream(msg: RecordMessage): string {
  return msg.record.stream
}

/** Extract the stream name from a SourceStateMessage, or undefined for global state. */
export function stateStream(msg: SourceStateMessage): string | undefined {
  return msg.source_state.state_type === 'global' ? undefined : msg.source_state.stream
}

/** Extract the state data from a SourceStateMessage. */
export function stateData(msg: SourceStateMessage): unknown {
  return msg.source_state.data
}

// MARK: - Type guards

export function isRecordMessage(msg: Message): msg is RecordMessage {
  return msg.type === 'record'
}

export function isStateMessage(msg: Message): msg is SourceStateMessage {
  return msg.type === 'source_state'
}

export function isCatalogMessage(msg: Message): msg is CatalogMessage {
  return msg.type === 'catalog'
}

export function isLogMessage(msg: Message): msg is LogMessage {
  return msg.type === 'log'
}

export function isSpecMessage(msg: Message): msg is SpecMessage {
  return msg.type === 'spec'
}

export function isConnectionStatusMessage(msg: Message): msg is ConnectionStatusMessage {
  return msg.type === 'connection_status'
}

export function isControlMessage(msg: Message): msg is ControlMessage {
  return msg.type === 'control'
}

export function isStreamStatusMessage(msg: Message): msg is StreamStatusMessage {
  return msg.type === 'stream_status'
}

export function isProgressMessage(msg: Message): msg is ProgressMessage {
  return msg.type === 'progress'
}

export function isEofMessage(msg: Message): msg is EofMessage {
  return msg.type === 'eof'
}

/** Type guard for "data" messages: record + source_state (the DestinationInput union). */
export function isDataMessage(msg: Message): msg is DestinationInput {
  return msg.type === 'record' || msg.type === 'source_state'
}

export function emptySectionState(): SectionState {
  return { streams: {}, global: {} }
}

export function emptySyncState(): SyncState {
  return {
    source: emptySectionState(),
    destination: emptySectionState(),
    engine: emptySectionState(),
  }
}

function coerceSectionState(input: unknown): SectionState {
  if (!input || typeof input !== 'object') return emptySectionState()
  const obj = input as Record<string, unknown>
  return {
    streams:
      obj.streams && typeof obj.streams === 'object'
        ? (obj.streams as Record<string, unknown>)
        : {},
    global:
      obj.global && typeof obj.global === 'object' ? (obj.global as Record<string, unknown>) : {},
  }
}

/**
 * Backward-compatible coercion for sync state.
 *
 * Accepts:
 * - SyncState { source, destination, engine }
 * - SourceState / SectionState { streams, global }
 * - legacy flat per-stream map { customers: { ... } }
 */
export function coerceSyncState(input: unknown): SyncState | undefined {
  if (input == null) return undefined
  if (typeof input !== 'object') return undefined

  const obj = input as Record<string, unknown>
  if ('source' in obj || 'destination' in obj || 'engine' in obj) {
    return {
      source: coerceSectionState(obj.source),
      destination: coerceSectionState(obj.destination),
      engine: coerceSectionState(obj.engine),
    }
  }
  if ('streams' in obj || 'global' in obj) {
    return {
      ...emptySyncState(),
      source: coerceSectionState(obj),
    }
  }
  return {
    ...emptySyncState(),
    source: { streams: obj, global: {} },
  }
}

// MARK: - Stream collector

/**
 * Generic stream collector. Drains the stream, accumulating messages whose
 * `type` matches one of the given types. Log messages are always collected
 * into `logs`. Connection failures always throw.
 *
 * With no type arguments, acts as a drain (consumes all, returns logs only).
 *
 * @example
 *   // Collect a single spec message
 *   const { messages: [specMsg] } = await collect(connector.spec(), 'spec')
 *
 *   // Collect all control messages
 *   const { messages } = await collect(stream, 'control')
 *
 *   // Drain, collecting logs and throwing on connection failures
 *   const { logs } = await collect(stream)
 */
export async function collectMessages<T extends Message['type']>(
  stream: AsyncIterable<{ type: string }>,
  ...types: T[]
): Promise<{ messages: Extract<Message, { type: T }>[]; logs: string[] }> {
  const logs: string[] = []
  const messages: Extract<Message, { type: T }>[] = []
  const typeSet = new Set<string>(types)
  for await (const raw of stream) {
    const msg = raw as Message
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'connection_status' && msg.connection_status.status === 'failed') {
      throw new Error(msg.connection_status.message ?? 'connection failed')
    }
    if (typeSet.has(msg.type)) {
      messages.push(msg as Extract<Message, { type: T }>)
    }
  }
  return { messages, logs }
}

/**
 * Collect the first message of a given type from a stream.
 * Throws if the stream ends without emitting a matching message.
 * Log messages are collected; connection failures throw.
 */
export async function collectFirst<T extends Message['type']>(
  stream: AsyncIterable<{ type: string }>,
  type: T
): Promise<Extract<Message, { type: T }>> {
  const { messages } = await collectMessages(stream, type)
  const first = messages[0]
  if (!first) throw new Error(`stream ended without emitting a '${type}' message`)
  return first
}

/** Drain a stream, collecting logs and throwing on connection failures. */
export async function drain(stream: AsyncIterable<{ type: string }>): Promise<{ logs: string[] }> {
  return collectMessages(stream)
}

// MARK: - Envelope constructors

/** Shorthand to create a record envelope message. */
export function recordMsg(payload: RecordPayload): RecordMessage {
  return { type: 'record', record: payload }
}

/** Shorthand to create a source_config control message. */
export function sourceControlMsg<T extends Record<string, unknown>>(
  source_config: T
): ControlMessage {
  return {
    type: 'control',
    control: { control_type: 'source_config', source_config },
  }
}

/** Shorthand to create a destination_config control message. */
export function destinationControlMsg<T extends Record<string, unknown>>(
  destination_config: T
): ControlMessage {
  return {
    type: 'control',
    control: { control_type: 'destination_config', destination_config },
  }
}

/** Shorthand to create a stream source_state envelope message. */
export function stateMsg(payload: { stream: string; data: unknown }): SourceStateMessage
/** Shorthand to create a global source_state envelope message. */
export function stateMsg(payload: { state_type: 'global'; data: unknown }): SourceStateMessage
export function stateMsg(
  payload: { stream: string; data: unknown } | { state_type: 'global'; data: unknown }
): SourceStateMessage {
  const source_state: StreamStatePayload | GlobalStatePayload =
    'state_type' in payload
      ? (payload as GlobalStatePayload)
      : { state_type: 'stream' as const, ...(payload as { stream: string; data: unknown }) }
  return { type: 'source_state', source_state }
}

/** Shorthand to create a stream_status envelope message. */
export function streamStatusMsg(payload: StreamStatusPayload): StreamStatusMessage {
  return { type: 'stream_status', stream_status: payload }
}

// MARK: - Source message factory

/** Per-stream state payload with typed data field. */
type TypedStreamStatePayload<TStreamState> = {
  state_type: 'stream'
  stream: string
  data: TStreamState
}

/** Global state payload with typed data field. */
type TypedGlobalStatePayload<TGlobalState> = {
  state_type: 'global'
  data: TGlobalState
}

/**
 * Type-safe message factory for source connectors.
 *
 * Every method is a 1:1 envelope wrapper: `(payload) => { type, payload }`.
 * No transforms, no defaults, no magic. The caller provides the exact payload
 * shape and gets the exact message shape.
 *
 * Generic parameters enforce connector-specific shapes at the call site:
 * - `TStreamState` — per-stream checkpoint data (e.g. `StreamState` for Stripe)
 * - `TGlobalState` — global state shared across streams
 * - `TRecordData` — record data shape
 *
 * Discriminated unions use `Extract` generics so TS enforces per-variant fields.
 *
 * @example
 *   const msg = createSourceMessageFactory<StreamState, { events_cursor: number }>()
 *   yield msg.record({ stream: 'customers', data: { id: 'cus_1' }, emitted_at: ts })
 *   yield msg.stream_status({ stream: 'customers', status: 'error', error: 'boom' })
 *   yield msg.source_state({ state_type: 'stream', stream: 'customers', data: { remaining: [] } })
 *   yield msg.source_state({ state_type: 'global', data: { events_cursor: 123 } })
 *   yield msg.connection_status({ status: 'failed', message: 'bad key' })
 *   yield msg.log({ level: 'warn', message: 'rate limited' })
 */
export function createSourceMessageFactory<
  TStreamState,
  TGlobalState extends Record<string, unknown>,
  TRecordData extends Record<string, unknown>,
>() {
  return {
    record(payload: { stream: string; data: TRecordData; emitted_at: string }): RecordMessage {
      return { type: 'record', record: payload }
    },

    source_state(
      payload: TypedStreamStatePayload<TStreamState> | TypedGlobalStatePayload<TGlobalState>
    ): SourceStateMessage {
      return { type: 'source_state', source_state: payload }
    },

    stream_status<S extends StreamStatusPayload['status']>(
      payload: Extract<StreamStatusPayload, { status: S }>
    ): StreamStatusMessage {
      return { type: 'stream_status', stream_status: payload }
    },

    connection_status(payload: ConnectionStatusPayload): ConnectionStatusMessage {
      return { type: 'connection_status', connection_status: payload }
    },

    log(payload: LogPayload): LogMessage {
      return { type: 'log', log: payload }
    },

    control<C extends ControlPayload['control_type']>(
      payload: Extract<ControlPayload, { control_type: C }>
    ): ControlMessage {
      return { type: 'control', control: payload }
    },
  }
}

// MARK: - Engine message factory

/**
 * Type-safe message factory for the engine.
 *
 * Same 1:1 envelope pattern as `createSourceMessageFactory`.
 * Covers the message types the engine constructs: eof, progress, log.
 */
export function createEngineMessageFactory() {
  return {
    eof(payload: EofPayload): EofMessage {
      return { type: 'eof', eof: payload }
    },

    progress(payload: ProgressPayload): ProgressMessage {
      return { type: 'progress', progress: payload }
    },

    log(payload: LogPayload): LogMessage {
      return { type: 'log', log: payload }
    },
  }
}
