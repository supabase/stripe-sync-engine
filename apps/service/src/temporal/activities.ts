import { heartbeat } from '@temporalio/activity'
import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig, Message, SetupResult, SyncOpts } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'

export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: Record<string, unknown>
}

/** Convert an array to an async iterable. */
async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

/** Iterate a message stream, collecting errors/state/records/eof and heartbeating. */
async function drainMessages(stream: AsyncIterable<Record<string, unknown>>): Promise<{
  errors: RunResult['errors']
  state: Record<string, unknown>
  records: unknown[]
  eof?: { reason: string }
}> {
  const errors: RunResult['errors'] = []
  const state: Record<string, unknown> = {}
  const records: unknown[] = []
  let eof: { reason: string } | undefined
  let count = 0

  for await (const m of stream) {
    count++
    if (m.type === 'eof') {
      eof = { reason: m.reason as string }
    } else if (m.type === 'error') {
      errors.push({
        message:
          (m.message as string) ||
          ((m.data as Record<string, unknown>)?.message as string) ||
          'Unknown error',
        failure_type: m.failure_type as string | undefined,
        stream: m.stream as string | undefined,
      })
    } else if (m.type === 'state' && typeof m.stream === 'string') {
      state[m.stream] = m.data
    } else if (m.type === 'record') {
      records.push(m)
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, eof }
}

export function createActivities(opts: { engineUrl: string; kafkaBroker?: string }) {
  const { engineUrl, kafkaBroker } = opts

  // Single engine client shared across all activity calls
  const engine = createRemoteEngine(engineUrl)

  // Shared Kafka client + producer (created lazily, reused across activity calls)
  let kafka: Kafka | undefined
  let producerConnected: Promise<import('kafkajs').Producer> | undefined

  function getKafka(): Kafka {
    if (!kafka) {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')
      kafka = new Kafka({ brokers: [kafkaBroker] })
    }
    return kafka
  }

  function getProducer(): Promise<import('kafkajs').Producer> {
    if (!producerConnected) {
      const producer = getKafka().producer()
      producerConnected = producer.connect().then(() => producer)
    }
    return producerConnected
  }

  function topicName(pipelineId: string): string {
    return `pipeline.${pipelineId}`
  }

  return {
    async setup(config: PipelineConfig): Promise<SetupResult> {
      return engine.pipeline_setup(config)
    },

    async syncImmediate(
      config: PipelineConfig,
      activityOpts?: SyncOpts & { input?: unknown[] }
    ): Promise<RunResult & { eof?: { reason: string } }> {
      const { input: inputArr, ...syncOpts } = activityOpts ?? {}
      const input = inputArr?.length ? asIterable(inputArr) : undefined
      const { errors, state, eof } = await drainMessages(
        engine.pipeline_sync(config, syncOpts, input) as AsyncIterable<Record<string, unknown>>
      )
      return { errors, state, eof }
    },

    async readIntoQueue(
      config: PipelineConfig,
      pipelineId: string,
      activityOpts?: SyncOpts & { input?: unknown[] }
    ): Promise<{ count: number; state: Record<string, unknown>; eof?: { reason: string } }> {
      const { input: inputArr, ...syncOpts } = activityOpts ?? {}
      const input = inputArr?.length ? asIterable(inputArr) : undefined
      const { records, state, eof } = await drainMessages(
        engine.pipeline_read(config, syncOpts, input) as AsyncIterable<Record<string, unknown>>
      )

      // If Kafka is configured, produce records to the pipeline topic
      if (kafkaBroker && records.length > 0) {
        const producer = await getProducer()
        await producer.send({
          topic: topicName(pipelineId),
          messages: records.map((r) => ({ value: JSON.stringify(r) })),
        })
      }

      return { count: records.length, state, eof }
    },

    async writeFromQueue(
      config: PipelineConfig,
      pipelineId: string,
      activityOpts?: { records?: unknown[]; maxBatch?: number }
    ): Promise<RunResult & { written: number }> {
      let records: unknown[]

      if (kafkaBroker) {
        // Consume a batch from Kafka
        const maxBatch = activityOpts?.maxBatch ?? 50
        records = []
        const consumer = getKafka().consumer({ groupId: `pipeline.${pipelineId}` })
        await consumer.connect()
        await consumer.subscribe({ topic: topicName(pipelineId), fromBeginning: false })

        await new Promise<void>((resolve) => {
          consumer.run({
            eachMessage: async ({ message }) => {
              if (message.value) {
                records.push(JSON.parse(message.value.toString()))
              }
              if (records.length >= maxBatch) {
                resolve()
              }
            },
          })
          // If fewer than maxBatch messages are available, resolve after a short wait
          setTimeout(resolve, 2000)
        })

        await consumer.disconnect()
      } else {
        // In-memory mode: records passed directly
        records = activityOpts?.records ?? []
      }

      if (records.length === 0) {
        return { errors: [], state: {}, written: 0 }
      }

      const { errors, state } = await drainMessages(
        engine.pipeline_write(
          config,
          asIterable(records) as AsyncIterable<Message>
        ) as AsyncIterable<Record<string, unknown>>
      )

      return { errors, state, written: records.length }
    },

    async teardown(config: PipelineConfig): Promise<void> {
      await engine.pipeline_teardown(config)
    },
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
