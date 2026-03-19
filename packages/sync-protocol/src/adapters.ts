import type { RecordMessage } from './types'

/** Wrap a raw object into a RecordMessage. */
export function toRecordMessage(stream: string, data: Record<string, unknown>): RecordMessage {
  return {
    type: 'record',
    stream,
    data,
    emitted_at: Date.now(),
  }
}

/** Extract the raw data from a RecordMessage. */
export function fromRecordMessage(msg: RecordMessage): Record<string, unknown> {
  return msg.data as Record<string, unknown>
}
