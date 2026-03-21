import { z } from 'zod'
import type { Destination, Message } from './protocol'

export const spec = z.object({})
export { spec as testDestinationSpec }

export type TestDestinationConfig = z.infer<typeof spec>

export const testDestination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check() {
    return { status: 'succeeded' as const }
  },

  async *write(
    _params: { config: TestDestinationConfig; catalog: unknown },
    $stdin: AsyncIterable<Message>
  ) {
    for await (const msg of $stdin) {
      if (msg.type === 'state') {
        yield msg
      }
    }
  },
} satisfies Destination<TestDestinationConfig>

export default testDestination
