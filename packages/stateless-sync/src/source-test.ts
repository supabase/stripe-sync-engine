import { z } from 'zod'
import type { Source } from '@stripe/sync-protocol'

export const spec = z.object({
  /** Stream definitions: name -> { primary_key? }. Used for catalog discovery only. */
  streams: z
    .record(
      z.string(),
      z.object({
        primary_key: z.array(z.array(z.string())).optional(),
      })
    )
    .optional(),
  /** If set, emit auth_error after this many records from $stdin. For testing retry logic. */
  auth_error_after: z.number().optional(),
})

export { spec as testSourceSpec }
export type TestSourceConfig = z.infer<typeof spec>

export const testSource = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check() {
    return { status: 'succeeded' as const }
  },

  async discover({ config }: { config: TestSourceConfig }) {
    const streams = config.streams
      ? Object.entries(config.streams).map(([name, def]) => ({
          name,
          primary_key: def.primary_key ?? [['id']],
        }))
      : []
    return { type: 'catalog' as const, streams }
  },

  async *read({ config }: { config: TestSourceConfig }, $stdin?: AsyncIterable<unknown>) {
    if (!$stdin) return
    let recordCount = 0
    for await (const msg of $stdin as AsyncIterable<any>) {
      if (config.auth_error_after != null && recordCount >= config.auth_error_after) {
        yield {
          type: 'error' as const,
          failure_type: 'auth_error' as const,
          message: 'Simulated auth error',
        }
        return
      }
      yield msg
      if (msg.type === 'record') recordCount++
    }
  },
} satisfies Source<TestSourceConfig>

export default testSource
