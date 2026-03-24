import { z } from 'zod'
import type { Destination, Message } from '@tx-stripe/protocol'

export const spec = z.object({})
export { spec as destinationTestSpec }

export type DestinationTestConfig = z.infer<typeof spec>

export const destinationTest = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check() {
    return { status: 'succeeded' as const }
  },

  async *write(
    _params: { config: DestinationTestConfig; catalog: unknown },
    $stdin: AsyncIterable<Message>
  ) {
    for await (const msg of $stdin) {
      if (msg.type === 'state') {
        yield msg
      }
    }
  },
} satisfies Destination<DestinationTestConfig>

export default destinationTest
