import type {
  CatalogMessage,
  DestinationInput,
  ErrorMessage,
  LogMessage,
  Message,
  RecordMessage,
  StateMessage,
  StreamStatusMessage,
} from './protocol.js'

// MARK: - Message constructors

/** Wrap a raw object into a RecordMessage. */
export function toRecordMessage(stream: string, data: Record<string, unknown>): RecordMessage {
  return {
    type: 'record',
    stream,
    data,
    emitted_at: new Date().toISOString(),
  }
}

/** Extract the raw data from a RecordMessage. */
export function fromRecordMessage(msg: RecordMessage): Record<string, unknown> {
  return msg.data as Record<string, unknown>
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

export function isErrorMessage(msg: Message): msg is ErrorMessage {
  return msg.type === 'error'
}

export function isStreamStatusMessage(msg: Message): msg is StreamStatusMessage {
  return msg.type === 'stream_status'
}

/** Type guard for "data" messages: record + state (the DestinationInput union). */
export function isDataMessage(msg: Message): msg is DestinationInput {
  return msg.type === 'record' || msg.type === 'state'
}
