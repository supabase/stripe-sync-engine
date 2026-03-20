import { z } from 'zod'
import type { Destination } from '@stripe/sync-protocol'

// MARK: - Spec

export const spec = z.object({})

export type Config = z.infer<typeof spec>

// MARK: - Destination

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check() {
    return { status: 'succeeded' as const }
  },

  async *write(_params, $stdin) {
    for await (const msg of $stdin) {
      process.stdout.write(JSON.stringify(msg) + '\n')
      if (msg.type === 'state') {
        yield msg
      }
    }
  },
} satisfies Destination<Config>

export default destination
