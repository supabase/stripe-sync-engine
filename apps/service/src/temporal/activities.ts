import { heartbeat } from '@temporalio/activity'
import { createRemoteEngine } from '@stripe/sync-engine'
import type { PipelineConfig, Message } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { RunResult } from './types.js'

/**
 * Resolve a pipeline's config with credentials inlined from the service.
 */
async function resolveConfig(serviceUrl: string, pipelineId: string): Promise<PipelineConfig> {
  const resp = await fetch(`${serviceUrl}/pipelines/${pipelineId}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Failed to resolve pipeline ${pipelineId} (${resp.status}): ${text}`)
  }
  return (await resp.json()) as PipelineConfig
}

/** Convert an array to an async iterable. */
async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

/** Iterate a message stream, collecting errors/state/records and heartbeating. */
async function drainMessages(stream: AsyncIterable<Record<string, unknown>>): Promise<{
  errors: RunResult['errors']
  state: Record<string, unknown>
  records: unknown[]
}> {
  const errors: RunResult['errors'] = []
  const state: Record<string, unknown> = {}
  const records: unknown[] = []
  let count = 0

  for await (const m of stream) {
    count++
    if (m.type === 'error') {
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

  return { errors, state, records }
}

export function createActivities(opts: {
  serviceUrl: string
  engineUrl: string
  kafkaBroker?: string
}) {
  const { serviceUrl, engineUrl, kafkaBroker } = opts

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
    async setup(pipelineId: string): Promise<void> {
      const config = await resolveConfig(serviceUrl, pipelineId)
      const engine = createRemoteEngine(engineUrl, config)
      await engine.setup()
    },

    async sync(
      pipelineId: string,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<RunResult> {
      const config = await resolveConfig(serviceUrl, pipelineId)
      const engine = createRemoteEngine(engineUrl, config, {
        state: opts?.state,
        stateLimit: opts?.stateLimit,
      })
      const input = opts?.input?.length ? asIterable(opts.input) : undefined
      const { errors, state } = await drainMessages(
        engine.sync(input) as AsyncIterable<Record<string, unknown>>
      )
      return { errors, state }
    },

    async read(
      pipelineId: string,
      opts?: { input?: unknown[]; state?: Record<string, unknown>; stateLimit?: number }
    ): Promise<{ count: number; records: unknown[]; state: Record<string, unknown> }> {
      const config = await resolveConfig(serviceUrl, pipelineId)
      const engine = createRemoteEngine(engineUrl, config, {
        state: opts?.state,
        stateLimit: opts?.stateLimit,
      })
      const input = opts?.input?.length ? asIterable(opts.input) : undefined
      const { records, state } = await drainMessages(
        engine.read(input) as AsyncIterable<Record<string, unknown>>
      )

      // If Kafka is configured, produce records to the pipeline topic
      if (kafkaBroker && records.length > 0) {
        const producer = await getProducer()
        await producer.send({
          topic: topicName(pipelineId),
          messages: records.map((r) => ({ value: JSON.stringify(r) })),
        })
      }

      return { count: records.length, records, state }
    },

    async write(
      pipelineId: string,
      opts?: { records?: unknown[]; maxBatch?: number }
    ): Promise<RunResult & { written: number }> {
      const config = await resolveConfig(serviceUrl, pipelineId)
      let records: unknown[]

      if (kafkaBroker) {
        // Consume a batch from Kafka
        const maxBatch = opts?.maxBatch ?? 50
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
        records = opts?.records ?? []
      }

      if (records.length === 0) {
        return { errors: [], state: {}, written: 0 }
      }

      const engine = createRemoteEngine(engineUrl, config)
      const { errors, state } = await drainMessages(
        engine.write(asIterable(records) as AsyncIterable<Message>) as AsyncIterable<
          Record<string, unknown>
        >
      )

      return { errors, state, written: records.length }
    },

    async teardown(pipelineId: string): Promise<void> {
      const config = await resolveConfig(serviceUrl, pipelineId)
      const engine = createRemoteEngine(engineUrl, config)
      await engine.teardown()
    },
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
