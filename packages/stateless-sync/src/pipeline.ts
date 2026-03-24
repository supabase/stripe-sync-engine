import type {
  DestinationInput,
  DestinationOutput,
  Message,
  StateMessage,
} from '@tx-stripe/protocol'
import {
  isDataMessage,
  isLogMessage,
  isErrorMessage,
  isStreamStatusMessage,
} from '@tx-stripe/protocol'

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
 * Reads destination output, yields StateMessage checkpoints.
 * Routes ErrorMessage and LogMessage to callbacks.
 */
export async function* collect(
  output: AsyncIterable<DestinationOutput>,
  callbacks?: RouterCallbacks
): AsyncIterable<StateMessage> {
  for await (const msg of output) {
    if (msg.type === 'state') {
      yield msg
    } else if (msg.type === 'log') {
      callbacks?.onLog?.(msg.message, msg.level)
    } else if (msg.type === 'error') {
      callbacks?.onError?.(msg.message, msg.failure_type)
    }
  }
}
