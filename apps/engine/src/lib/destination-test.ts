import { z } from 'zod'
import type {
  Destination,
  SpecOutput,
  CheckOutput,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'

export const spec = z.object({})
export { spec as destinationTestSpec }

export type DestinationTestConfig = z.infer<typeof spec>

export const destinationTest = {
  async *spec(): AsyncIterable<SpecOutput> {
    yield { type: 'spec', spec: { config: z.toJSONSchema(spec) } }
  },

  async *check(): AsyncIterable<CheckOutput> {
    yield {
      type: 'connection_status',
      connection_status: { status: 'succeeded' as const },
    }
  },

  async *write(
    _params: { config: Record<string, unknown>; catalog: unknown },
    $stdin: AsyncIterable<DestinationInput>
  ): AsyncIterable<DestinationOutput> {
    for await (const msg of $stdin) {
      if (msg.type === 'source_state') {
        yield msg
      }
    }
  },
} satisfies Destination

export default destinationTest
