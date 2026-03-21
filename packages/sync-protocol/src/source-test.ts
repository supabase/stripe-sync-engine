import { z } from 'zod'
import type { Source } from './protocol'
import { toRecordMessage } from './adapters'

export const spec = z.object({
  /** Stream definitions: name -> { records, primary_key? }. When provided, yields these. */
  streams: z
    .record(
      z.string(),
      z.object({
        records: z.array(z.record(z.string(), z.unknown())),
        primary_key: z.array(z.array(z.string())).optional(),
      })
    )
    .optional(),
  /** If set, emit auth_error after this many total records. For testing retry logic. */
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

  async *read({ config }: { config: TestSourceConfig }, _$stdin?: AsyncIterable<unknown>) {
    if (!config.streams) return
    let totalRecords = 0
    for (const [streamName, streamDef] of Object.entries(config.streams)) {
      for (const record of streamDef.records) {
        if (config.auth_error_after != null && totalRecords >= config.auth_error_after) {
          yield {
            type: 'error' as const,
            failure_type: 'auth_error' as const,
            message: 'Simulated auth error',
          }
          return
        }
        yield toRecordMessage(streamName, record)
        totalRecords++
      }
      yield {
        type: 'state' as const,
        stream: streamName,
        data: { status: 'complete' },
      }
    }
  },
} satisfies Source<TestSourceConfig>

export default testSource
