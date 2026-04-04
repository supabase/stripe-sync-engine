import { heartbeat } from '@temporalio/activity'
import type { Message } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { Producer } from 'kafkajs'
import type { PipelineStore } from '../../lib/stores.js'

export interface ActivitiesContext {
  engineUrl: string
  kafkaBroker?: string
  pipelines: PipelineStore
  getProducer(): Promise<Producer>
  consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]>
}

export function createActivitiesContext(opts: {
  engineUrl: string
  kafkaBroker?: string
  pipelines: PipelineStore
}): ActivitiesContext {
  const { engineUrl, kafkaBroker, pipelines } = opts

  let kafka: Kafka | undefined
  let producerConnected: Promise<Producer> | undefined

  function getKafka(): Kafka {
    if (!kafka) {
      if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')
      kafka = new Kafka({ brokers: [kafkaBroker] })
    }
    return kafka
  }

  function topicName(pipelineId: string): string {
    return `pipeline.${pipelineId}`
  }

  async function getProducer(): Promise<Producer> {
    if (!producerConnected) {
      const producer = getKafka().producer()
      producerConnected = producer.connect().then(() => producer)
    }
    return producerConnected
  }

  async function consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]> {
    if (!kafkaBroker) throw new Error('kafkaBroker is required for read-write mode')

    const topic = topicName(pipelineId)
    const messages: Message[] = []
    const offsets = new Map<number, string>()
    const consumer = getKafka().consumer({ groupId: `pipeline.${pipelineId}` })
    await consumer.connect()
    await consumer.subscribe({ topic, fromBeginning: true })

    try {
      await new Promise<void>((resolve) => {
        let resolved = false
        const finish = () => {
          if (resolved) return
          resolved = true
          resolve()
        }

        consumer.run({
          eachMessage: async ({ partition, message }) => {
            if (message.value) {
              messages.push(JSON.parse(message.value.toString()) as Message)
              offsets.set(partition, (BigInt(message.offset) + 1n).toString())
            }
            if (messages.length >= maxBatch) finish()
          },
        })

        setTimeout(finish, 2000)
      })

      await consumer.stop()

      if (offsets.size > 0) {
        await consumer.commitOffsets(
          [...offsets.entries()].map(([partition, offset]) => ({
            topic,
            partition,
            offset,
          }))
        )
      }
    } finally {
      await consumer.disconnect()
    }

    return messages
  }

  return {
    engineUrl,
    kafkaBroker,
    pipelines,
    getProducer,
    consumeQueueBatch,
  }
}

export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
  state: Record<string, unknown>
}

export async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

export function pipelineHeader(config: Record<string, unknown>): string {
  return JSON.stringify(config)
}

export function collectError(message: Record<string, unknown>): RunResult['errors'][number] | null {
  if (message.type === 'trace') {
    const trace = message.trace as Record<string, unknown> | undefined
    if (trace?.trace_type === 'error') {
      const error = trace.error as Record<string, unknown>
      return {
        message: (error.message as string) || 'Unknown error',
        failure_type: error.failure_type as string | undefined,
        stream: error.stream as string | undefined,
      }
    }
  }
  return null
}

export async function drainMessages(stream: AsyncIterable<Record<string, unknown>>): Promise<{
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

  for await (const message of stream) {
    count++
    if (message.type === 'eof') {
      const eofPayload = message.eof as Record<string, unknown>
      eof = { reason: eofPayload.reason as string }
    } else {
      const error = collectError(message)
      if (error) {
        errors.push(error)
      } else if (message.type === 'state') {
        const statePayload = message.state as Record<string, unknown>
        state[statePayload.stream as string] = statePayload.data
      } else if (message.type === 'record') {
        records.push(message)
      }
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, eof }
}
