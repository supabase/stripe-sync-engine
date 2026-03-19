import type {
  CatalogMessage,
  DestinationInput,
  ErrorMessage,
  LogMessage,
  Message,
  RecordMessage,
  StateMessage,
  StreamStatusMessage,
} from './types'

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

// MARK: - Filter helpers

/**
 * Filter a message stream to only data messages (RecordMessage + StateMessage).
 * This is what the orchestrator's `forward` stage uses to strip logs, errors,
 * and status messages before passing the stream to a destination.
 */
export async function* filterDataMessages(
  messages: AsyncIterableIterator<Message>
): AsyncIterableIterator<DestinationInput> {
  for await (const msg of messages) {
    if (isDataMessage(msg)) {
      yield msg
    }
  }
}
