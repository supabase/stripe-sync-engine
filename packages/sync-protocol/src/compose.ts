import type { Message } from './types'

/**
 * Transforms a message stream. Composable -- multiple transforms can be
 * chained into a pipeline between source and destination.
 *
 * Because it operates on AsyncIterableIterator, a transform can:
 *   - Filter (drop messages)
 *   - Map (modify records)
 *   - Buffer (batch/window)
 *   - Multiplex (split one stream into many)
 *   - Aggregate (reduce many records into one)
 */
export interface Transform {
  (messages: AsyncIterableIterator<Message>): AsyncIterableIterator<Message>
}

/**
 * Compose transforms left-to-right into a single transform.
 *
 * compose(a, b, c)(input) === c(b(a(input)))
 *
 * With zero transforms, returns the identity (passthrough).
 */
export function compose(...transforms: Transform[]): Transform {
  return (messages) =>
    transforms.reduce<AsyncIterableIterator<Message>>(
      (stream, transform) => transform(stream),
      messages
    )
}
