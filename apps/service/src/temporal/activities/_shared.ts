import { heartbeat } from '@temporalio/activity'
import type { ConfiguredCatalog, Message, RecordMessage } from '@stripe/sync-engine'
import { Kafka } from 'kafkajs'
import type { Producer } from 'kafkajs'
import {
  ROW_KEY_FIELD,
  ROW_NUMBER_FIELD,
  serializeRowKey,
} from '@stripe/sync-destination-google-sheets'

export interface ActivitiesContext {
  engineUrl: string
  kafkaBroker?: string
  getProducer(): Promise<Producer>
  consumeQueueBatch(pipelineId: string, maxBatch: number): Promise<Message[]>
}

export function createActivitiesContext(opts: {
  engineUrl: string
  kafkaBroker?: string
}): ActivitiesContext {
  const { engineUrl, kafkaBroker } = opts

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
  if (message.type !== 'error') return null
  return {
    message:
      (message.message as string) ||
      ((message.data as Record<string, unknown>)?.message as string) ||
      'Unknown error',
    failure_type: message.failure_type as string | undefined,
    stream: message.stream as string | undefined,
  }
}

export function withRowKey(record: RecordMessage, catalog?: ConfiguredCatalog): RecordMessage {
  const primaryKey = catalog?.streams.find((stream) => stream.stream.name === record.stream)?.stream
    .primary_key
  if (!primaryKey) return record
  return {
    ...record,
    data: {
      ...record.data,
      [ROW_KEY_FIELD]: serializeRowKey(primaryKey, record.data),
    },
  }
}

export function compactGoogleSheetsMessages(messages: Message[]): Message[] {
  const compacted: Message[] = []
  let pendingOrder: string[] = []
  let pending = new Map<string, RecordMessage>()

  const flushPending = () => {
    for (const key of pendingOrder) {
      const message = pending.get(key)
      if (message) compacted.push(message)
    }
    pendingOrder = []
    pending = new Map()
  }

  for (const message of messages) {
    if (message.type === 'record') {
      const rowKey =
        typeof message.data[ROW_KEY_FIELD] === 'string' ? message.data[ROW_KEY_FIELD] : undefined
      if (!rowKey) {
        compacted.push(message)
        continue
      }
      const dedupeKey = `${message.stream}:${rowKey}`
      if (!pending.has(dedupeKey)) pendingOrder.push(dedupeKey)
      pending.set(dedupeKey, message)
      continue
    }

    if (message.type === 'state') {
      flushPending()
      compacted.push(message)
    }
  }

  flushPending()
  return compacted
}

export function addRowNumbers(
  messages: Message[],
  rowIndex: Record<string, Record<string, number>>
): Message[] {
  return messages.map((message) => {
    if (message.type !== 'record') return message
    const rowKey =
      typeof message.data[ROW_KEY_FIELD] === 'string' ? message.data[ROW_KEY_FIELD] : undefined
    const rowNumber = rowKey ? rowIndex[message.stream]?.[rowKey] : undefined
    if (rowNumber === undefined) return message
    return {
      ...message,
      data: {
        ...message.data,
        [ROW_NUMBER_FIELD]: rowNumber,
      },
    }
  })
}

export function augmentGoogleSheetsCatalog(catalog: ConfiguredCatalog): ConfiguredCatalog {
  return {
    streams: catalog.streams.map((configuredStream) => {
      const props = configuredStream.stream.json_schema?.properties as
        | Record<string, unknown>
        | undefined

      if (!props) return configuredStream

      return {
        ...configuredStream,
        stream: {
          ...configuredStream.stream,
          json_schema: {
            ...configuredStream.stream.json_schema,
            properties: {
              ...props,
              [ROW_KEY_FIELD]: { type: 'string' },
              [ROW_NUMBER_FIELD]: { type: 'number' },
            },
          },
        },
      }
    }),
  }
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
      eof = { reason: message.reason as string }
    } else {
      const error = collectError(message)
      if (error) {
        errors.push(error)
      } else if (message.type === 'state' && typeof message.stream === 'string') {
        state[message.stream] = message.data
      } else if (message.type === 'record') {
        records.push(message)
      }
    }
    if (count % 50 === 0) heartbeat({ messages: count })
  }
  if (count % 50 !== 0) heartbeat({ messages: count })

  return { errors, state, records, eof }
}
