import type {
  CatalogMessage,
  CatalogPayload,
  ConnectionStatusMessage,
  ConnectionStatusPayload,
  ControlMessage,
  DestinationInput,
  EofMessage,
  LogMessage,
  Message,
  RecordMessage,
  RecordPayload,
  SpecMessage,
  StateMessage,
  StatePayload,
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

/** Extract the stream name from a StateMessage. */
export function stateStream(msg: StateMessage): string {
  return msg.state.stream
}

/** Extract the state data from a StateMessage. */
export function stateData(msg: StateMessage): unknown {
  return msg.state.data
}

// MARK: - Type guards

export function isRecordMessage(msg: Message): msg is RecordMessage {
  return msg.type === 'record'
}

export function isStateMessage(msg: Message): msg is StateMessage {
  return msg.type === 'state'
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

/** Type guard for "data" messages: record + state (the DestinationInput union). */
export function isDataMessage(msg: Message): msg is DestinationInput {
  return msg.type === 'record' || msg.type === 'state'
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

// MARK: - Stream helpers

/**
 * Collect the first message of a given type from an async iterable.
 * Logs any LogMessages encountered. Throws on trace errors.
 * Returns the payload extracted from the envelope, or undefined if the stream ends
 * without emitting a message of the requested type.
 */
export async function collectSpec(
  stream: AsyncIterable<Message>
): Promise<{ spec: SpecMessage['spec']; logs: string[] }> {
  const logs: string[] = []
  for await (const msg of stream) {
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
    } else if (msg.type === 'spec') {
      return { spec: msg.spec, logs }
    }
  }
  throw new Error('spec stream ended without emitting a spec message')
}

export async function collectConnectionStatus(
  stream: AsyncIterable<Message>
): Promise<{ connection_status: ConnectionStatusPayload; logs: string[] }> {
  const logs: string[] = []
  for await (const msg of stream) {
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
    } else if (msg.type === 'connection_status') {
      return { connection_status: msg.connection_status, logs }
    }
  }
  throw new Error('check stream ended without emitting a connection_status message')
}

export async function collectCatalog(
  stream: AsyncIterable<Message>
): Promise<{ catalog: CatalogPayload; logs: string[] }> {
  const logs: string[] = []
  for await (const msg of stream) {
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
    } else if (msg.type === 'catalog') {
      return { catalog: msg.catalog, logs }
    }
  }
  throw new Error('discover stream ended without emitting a catalog message')
}

export async function collectControls(
  stream: AsyncIterable<Message>
): Promise<{ configs: Array<Record<string, unknown>>; logs: string[] }> {
  const logs: string[] = []
  const configs: Array<Record<string, unknown>> = []
  for await (const msg of stream) {
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
    } else if (msg.type === 'control' && msg.control.control_type === 'config_update') {
      configs.push(msg.control.config)
    }
  }
  return { configs, logs }
}

/** Drain a stream, logging LogMessages and throwing on trace errors. */
export async function drainStream(stream: AsyncIterable<Message>): Promise<{ logs: string[] }> {
  const logs: string[] = []
  for await (const msg of stream) {
    if (msg.type === 'log') {
      logs.push(`[${msg.log.level}] ${msg.log.message}`)
    } else if (msg.type === 'trace' && msg.trace.trace_type === 'error') {
      throw new Error(msg.trace.error.message)
    }
  }
  return { logs }
}

// MARK: - Envelope constructors

/** Shorthand to create a record envelope message. */
export function recordMsg(payload: RecordPayload): RecordMessage {
  return { type: 'record', record: payload }
}

/** Shorthand to create a state envelope message. */
export function stateMsg(payload: StatePayload): StateMessage {
  return { type: 'state', state: payload }
}
