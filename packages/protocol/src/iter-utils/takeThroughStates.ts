import { takeWhile } from 'ix/asynciterable/operators'
import type { Message } from '../protocol.js'

export interface TakeThroughStatesOptions {
  onLimitReached?: () => void
}

export function takeThroughStates(
  stateLimit: number,
  options?: TakeThroughStatesOptions
): (messages: AsyncIterable<Message>) => AsyncIterable<Message> {
  let stateCount = 0

  return (messages: AsyncIterable<Message>) =>
    takeWhile((message: Message) => {
      if (message.type === 'source_state') {
        stateCount += 1
        if (stateCount >= stateLimit) {
          options?.onLimitReached?.()
        }
        return stateCount <= stateLimit
      }

      return stateCount < stateLimit
    })(messages)
}
