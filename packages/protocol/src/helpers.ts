import type {
  ConnectionStatusMessage,
  ConnectionStatusPayload,
  ControlMessage,
  ControlPayload,
  EofMessage,
  EofPayload,
  GlobalStatePayload,
  Message,
  ProgressMessage,
  ProgressPayload,
  RecordMessage,
  SectionState,
  SourceState,
  SourceStateMessage,
  StreamStatusMessage,
  StreamStatusPayload,
  StreamStatePayload,
  SyncState,
} from './protocol.js'
import { SyncState as SyncStateSchema } from './protocol.js'
import type { z } from 'zod'

// MARK: - Message accessors

/** Extract the state data from a SourceStateMessage. */
export function stateData(msg: SourceStateMessage): unknown {
  return msg.source_state.data
}

export function emptySectionState(): SectionState {
  return { streams: {}, global: {} }
}

export function emptySourceState(): SourceState {
  return { streams: {}, global: {} }
}

export function emptySyncState(): SyncState {
  return {
    source: emptySourceState(),
    destination: {},
    sync_run: {
      progress: {
        started_at: '1970-01-01T00:00:00.000Z',
        elapsed_ms: 0,
        global_state_count: 0,
        derived: { status: 'started', records_per_second: 0, states_per_second: 0 },
        streams: {},
      },
    },
  }
}

/**
 * Parse sync state strictly. Returns undefined for null/undefined input,
 * or empty state if validation fails. When a streamStateSchema is provided,
 * every per-stream value is validated against it — any failure discards
 * the entire state.
 */
export function parseSyncState(
  input: unknown,
  streamStateSchema?: z.ZodType
): SyncState | undefined {
  if (input == null) return undefined
  const envelope = SyncStateSchema.safeParse(input)
  if (!envelope.success) return emptySyncState()
  if (!streamStateSchema) return envelope.data
  for (const value of Object.values(envelope.data.source.streams)) {
    if (value != null && !streamStateSchema.safeParse(value).success) {
      return emptySyncState()
    }
  }
  return envelope.data
}

/** @deprecated Use parseSyncState */
export const coerceSyncState = parseSyncState

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
 * Covers the message types the engine constructs: eof and progress.
 */
export function createEngineMessageFactory() {
  return {
    eof(payload: EofPayload): EofMessage {
      return { type: 'eof', eof: payload }
    },

    progress(payload: ProgressPayload): ProgressMessage {
      return { type: 'progress', progress: payload }
    },
  }
}
