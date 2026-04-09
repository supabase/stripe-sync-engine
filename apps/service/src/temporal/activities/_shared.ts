import { heartbeat } from '@temporalio/activity'
import type { Message, Engine, SourceState, SourceStateMessage } from '@stripe/sync-engine'
import { createRemoteEngine } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { Producer } from 'kafkajs'
import type { PipelineStore } from '../../lib/stores.js'
import type { SyncRunError } from '../sync-errors.js'

export interface ActivitiesContext {
  /** Remote engine client — satisfies the {@link Engine} interface over HTTP. Drop-in replacement for a local engine. */
  engine: Engine
  kafkaBroker?: string
  pipelineStore: PipelineStore
  getProducer(): Promise<Producer>
  consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]>
}

export function createActivitiesContext(opts: {
  engineUrl: string
  kafkaBroker?: string
  pipelineStore: PipelineStore
}): ActivitiesContext {
  const { engineUrl, kafkaBroker, pipelineStore } = opts

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
    engine: createRemoteEngine(engineUrl),
    kafkaBroker,
    pipelineStore,
    getProducer,
    consumeQueueBatch,
  }
}

export interface RunResult {
  errors: SyncRunError[]
  state: SourceState
}

export async function* asIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

export function pipelineHeader(config: Record<string, unknown>): string {
  return JSON.stringify(config)
}

export function mergeStateMessage(state: SourceState, msg: SourceStateMessage): SourceState {
  if (msg.source_state.state_type === 'global') {
    return { ...state, global: msg.source_state.data as Record<string, unknown> }
  }
  return {
    ...state,
    streams: { ...state.streams, [msg.source_state.stream]: msg.source_state.data },
  }
}

export function collectError(message: Message): RunResult['errors'][number] | null {
  if (message.type === 'trace' && message.trace.trace_type === 'error') {
    return {
      message: message.trace.error.message || 'Unknown error',
      failure_type: message.trace.error.failure_type,
      stream: message.trace.error.stream,
    }
  }
  return null
}

export async function drainMessages(
  stream: AsyncIterable<Message>,
  initialState?: SourceState
): Promise<{
  errors: RunResult['errors']
  state: SourceState
  records: Message[]
  sourceConfig?: Record<string, unknown>
  destConfig?: Record<string, unknown>
  eof?: { reason: string }
}> {
  const errors: RunResult['errors'] = []
  let state: SourceState = initialState ?? { streams: {}, global: {} }
  const records: Message[] = []
  let sourceConfig: Record<string, unknown> | undefined
  let destConfig: Record<string, unknown> | undefined
  let eof: { reason: string } | undefined
  let count = 0

  for await (const message of stream) {
    count++
    if (message.type === 'eof') {
      eof = { reason: message.eof.reason }
    } else if (message.type === 'control') {
      if (message.control.control_type === 'source_config') {
        sourceConfig = message.control.source_config!
      } else if (message.control.control_type === 'destination_config') {
        destConfig = message.control.destination_config!
      }
    } else {
      const error = collectError(message)
      if (error) {
        errors.push(error)
      } else if (message.type === 'source_state') {
        state = mergeStateMessage(state, message)
      } else if (message.type === 'record') {
        records.push(message)
      }
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, sourceConfig, destConfig, eof }
}
