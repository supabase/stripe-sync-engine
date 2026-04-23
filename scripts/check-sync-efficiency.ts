import { performance } from 'node:perf_hooks'
import {
  createEngine,
  destinationTest,
  type ConnectorResolver,
  type PipelineConfig,
  type Source,
} from '../apps/engine/src/index.js'
import { listApiBackfill } from '../packages/source-stripe/src/src-list-api.js'
import type { StripeClient } from '../packages/source-stripe/src/client.js'
import type { ResourceConfig } from '../packages/source-stripe/src/types.js'

const STREAM_COUNT = parseInt(process.env.SYNC_EFFICIENCY_STREAMS ?? '74', 10)
const RECORDS_PER_STREAM = parseInt(process.env.SYNC_EFFICIENCY_RECORDS ?? '200', 10)
const RATE_LIMIT = parseInt(process.env.SYNC_EFFICIENCY_RATE_LIMIT ?? '80', 10)
const MAX_CONCURRENT_STREAMS = parseInt(
  process.env.SYNC_EFFICIENCY_MAX_CONCURRENT_STREAMS ?? '5',
  10
)
const REQUEST_LATENCY_MS = parseInt(process.env.SYNC_EFFICIENCY_REQUEST_LATENCY_MS ?? '5', 10)
const MAX_STATE_MESSAGES = parseInt(process.env.SYNC_EFFICIENCY_MAX_STATE_MESSAGES ?? '200', 10)
const MIN_STATES_PER_SECOND = parseFloat(process.env.SYNC_EFFICIENCY_MIN_STATES_PER_SECOND ?? '50')

const TIME_RANGE = {
  gte: new Date(0).toISOString(),
  lt: new Date(1000 * 1000).toISOString(),
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeRecords(streamName: string): Array<{ id: string; created: number }> {
  return Array.from({ length: RECORDS_PER_STREAM }, (_, index) => ({
    id: `${streamName}_${String(index).padStart(3, '0')}`,
    created: index * 5,
  }))
}

function makeListFn(
  records: Array<{ id: string; created: number }>,
  counters: { requests: number }
): NonNullable<ResourceConfig['listFn']> {
  return async (params) => {
    counters.requests++
    await sleep(REQUEST_LATENCY_MS)

    const limit = typeof params?.limit === 'number' ? params.limit : 100
    const created = params?.created as { gte?: number; lt?: number } | undefined
    const startingAfter = typeof params?.starting_after === 'string' ? params.starting_after : null

    let filtered = records.filter((record) => {
      if (created?.gte != null && record.created < created.gte) return false
      if (created?.lt != null && record.created >= created.lt) return false
      return true
    })

    filtered = [...filtered].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))

    if (startingAfter) {
      const cursorIndex = filtered.findIndex((record) => record.id === startingAfter)
      if (cursorIndex >= 0) filtered = filtered.slice(cursorIndex + 1)
    }

    const data = filtered.slice(0, limit)
    return {
      data,
      has_more: filtered.length > data.length,
    }
  }
}

function buildSyntheticSource(counters: { requests: number }): Source<Record<string, never>> {
  const streamNames = Array.from(
    { length: STREAM_COUNT },
    (_, index) => `stream_${String(index).padStart(2, '0')}`
  )

  const registry: Record<string, ResourceConfig> = Object.fromEntries(
    streamNames.map((streamName) => [
      streamName,
      {
        order: 1,
        tableName: streamName,
        supportsCreatedFilter: true,
        listFn: makeListFn(makeRecords(streamName), counters),
      } satisfies ResourceConfig,
    ])
  )

  return {
    async *spec() {
      yield {
        type: 'spec',
        spec: {
          config: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      }
    },

    async *discover() {
      yield {
        type: 'catalog',
        catalog: {
          streams: streamNames.map((name) => ({
            name,
            primary_key: [['id']],
          })),
        },
      }
    },

    read({ catalog }) {
      const configuredCatalog = {
        streams: catalog.streams.map((stream) => ({
          stream: stream.stream,
          time_range: TIME_RANGE,
        })),
      }

      return listApiBackfill({
        catalog: configuredCatalog,
        state: undefined,
        registry,
        client: {} as StripeClient,
        accountId: 'acct_test_efficiency',
        rateLimiter: async () => 0,
        maxConcurrentStreams: MAX_CONCURRENT_STREAMS,
        maxRequestsPerSecond: RATE_LIMIT,
      })
    },
  }
}

async function main(): Promise<void> {
  const counters = { requests: 0 }
  const source = buildSyntheticSource(counters)

  const resolver: ConnectorResolver = {
    resolveSource: async (name) => {
      if (name !== 'efficiency') throw new Error(`Unknown source: ${name}`)
      return source
    },
    resolveDestination: async (name) => {
      if (name !== 'test') throw new Error(`Unknown destination: ${name}`)
      return destinationTest
    },
    sources: () => new Map(),
    destinations: () => new Map(),
  }

  const pipeline: PipelineConfig = {
    source: { type: 'efficiency', efficiency: {} },
    destination: { type: 'test', test: {} },
  }

  const engine = await createEngine(resolver)

  let observedStateMessages = 0
  let eof:
    | {
        run_progress: {
          global_state_count: number
          derived: { states_per_second: number }
        }
      }
    | undefined

  const startedAt = performance.now()
  for await (const msg of engine.pipeline_sync(pipeline)) {
    if (msg.type === 'source_state') observedStateMessages++
    if (msg.type === 'eof') eof = msg.eof as typeof eof
  }
  const elapsedMs = performance.now() - startedAt

  if (!eof) {
    throw new Error('Missing eof from efficiency sync run')
  }

  const checkpointCount = eof.run_progress.global_state_count
  const statesPerSecond = eof.run_progress.derived.states_per_second

  console.log(`streams=${STREAM_COUNT}`)
  console.log(`records_per_stream=${RECORDS_PER_STREAM}`)
  console.log(`requests=${counters.requests}`)
  console.log(`observed_state_messages=${observedStateMessages}`)
  console.log(`run_progress.global_state_count=${checkpointCount}`)
  console.log(`run_progress.derived.states_per_second=${statesPerSecond.toFixed(1)}`)
  console.log(`elapsed_ms=${elapsedMs.toFixed(1)}`)

  if (checkpointCount !== observedStateMessages) {
    throw new Error(
      `Checkpoint mismatch: observed ${observedStateMessages}, progress reported ${checkpointCount}`
    )
  }

  if (checkpointCount >= MAX_STATE_MESSAGES) {
    throw new Error(`Checkpoint count too high: ${checkpointCount} >= ${MAX_STATE_MESSAGES}`)
  }

  if (statesPerSecond <= MIN_STATES_PER_SECOND) {
    throw new Error(
      `Checkpoint throughput too low: ${statesPerSecond.toFixed(1)} <= ${MIN_STATES_PER_SECOND}`
    )
  }

  console.log('sync efficiency check passed')
}

await main()
