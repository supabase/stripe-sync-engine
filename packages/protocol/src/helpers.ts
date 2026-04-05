import type {
  CatalogMessage,
  ConnectionStatusMessage,
  ControlMessage,
  DestinationInput,
  EofMessage,
  GlobalStatePayload,
  LogMessage,
  Message,
  RecordMessage,
  RecordPayload,
  SourceStateMessage,
  SpecMessage,
  StreamStatePayload,
  TraceMessage,
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

export function isTraceMessage(msg: Message): msg is TraceMessage {
  return msg.type === 'trace'
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

export function isEofMessage(msg: Message): msg is EofMessage {
  return msg.type === 'eof'
}

/** Type guard for "data" messages: record + source_state (the DestinationInput union). */
export function isDataMessage(msg: Message): msg is DestinationInput {
  return msg.type === 'record' || msg.type === 'source_state'
}

/** Type guard for trace error messages. */
export function isTraceError(
  msg: Message
): msg is TraceMessage & { trace: { trace_type: 'error' } } {
  return msg.type === 'trace' && msg.trace.trace_type === 'error'
}

/** Type guard for trace stream_status messages. */
export function isTraceStreamStatus(
  msg: Message
): msg is TraceMessage & { trace: { trace_type: 'stream_status' } } {
  return msg.type === 'trace' && msg.trace.trace_type === 'stream_status'
}

// MARK: - Stream collector

/**
 * Generic stream collector. Drains the stream, accumulating messages whose
 * `type` matches one of the given types. Log messages are always collected
 * into `logs`. Trace errors always throw.
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
 *   // Drain, collecting logs and throwing on trace errors
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
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
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
 * Log messages are collected; trace errors throw.
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

/** Drain a stream, collecting logs and throwing on trace errors. */
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
