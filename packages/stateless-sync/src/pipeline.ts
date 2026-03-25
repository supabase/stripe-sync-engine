import type { DestinationInput, DestinationOutput, Message } from '@stripe/sync-protocol'
import {
  isDataMessage,
  isLogMessage,
  isErrorMessage,
  isStreamStatusMessage,
} from '@stripe/sync-protocol'

// MARK: - Filter helpers

/**
 * Filter a message stream to only data messages (RecordMessage + StateMessage).
 * This is what the orchestrator's `forward` stage uses to strip logs, errors,
 * and status messages before passing the stream to a destination.
 */
export async function* filterDataMessages(
  messages: AsyncIterable<Message>
): AsyncIterable<DestinationInput> {
  for await (const msg of messages) {
    if (isDataMessage(msg)) {
      yield msg
    }
  }
}

// MARK: - Pipeline stages

export type RouterCallbacks = {
  onLog?: (message: string, level: string) => void
  onError?: (message: string, failureType: string) => void
  onStreamStatus?: (stream: string, status: string) => void
}

/**
 * Sits between source and destination in a pipe.
 * Forwards RecordMessage and StateMessage to the destination.
 * Routes LogMessage, ErrorMessage, StreamStatusMessage to callbacks.
 */
export async function* forward(
  messages: AsyncIterable<Message>,
  callbacks?: RouterCallbacks
): AsyncIterable<DestinationInput> {
  for await (const msg of messages) {
    if (isDataMessage(msg)) {
      yield msg
    } else if (isLogMessage(msg)) {
      callbacks?.onLog?.(msg.message, msg.level)
    } else if (isErrorMessage(msg)) {
      callbacks?.onError?.(msg.message, msg.failure_type)
    } else if (isStreamStatusMessage(msg)) {
      callbacks?.onStreamStatus?.(msg.stream, msg.status)
    }
    // CatalogMessage is silently dropped
  }
}

/**
 * Sits after destination in a pipe.
 * Yields all destination output (state, log, error) to the caller.
 */
export async function* collect(
  output: AsyncIterable<DestinationOutput>
): AsyncIterable<DestinationOutput> {
  for await (const msg of output) {
    yield msg
  }
}
