import type {
  CheckResult,
  ConfiguredCatalog,
  ConnectorSpecification,
  Destination,
  DestinationInput,
  DestinationOutput,
  ErrorMessage,
  LogMessage,
} from '@stripe/sync-protocol'
import type { PostgresConfig } from './types'
import { PostgresDestinationWriter } from './writer'

/**
 * Postgres destination implementation.
 *
 * Writes records into a PostgreSQL database. Creates tables from
 * CatalogMessage schemas, batches RecordMessages, and confirms
 * StateMessages after committing preceding records.
 *
 * The existing PostgresDestinationWriter is used internally for
 * the actual upsert operations.
 */
export class PostgresDestination implements Destination {
  private readonly batchSize: number
  private readonly writer: PostgresDestinationWriter

  constructor(
    private readonly config: PostgresConfig,
    _writerForTesting?: PostgresDestinationWriter
  ) {
    this.batchSize = config.batchSize ?? 100
    this.writer = _writerForTesting ?? new PostgresDestinationWriter(config)
  }

  spec(): ConnectorSpecification {
    return {
      config: {
        type: 'object',
        required: ['connectionString'],
        properties: {
          connectionString: { type: 'string' },
          schema: { type: 'string', default: 'stripe' },
        },
      },
    }
  }

  async check(_params: { config: Record<string, unknown> }): Promise<CheckResult> {
    try {
      await this.writer.query('SELECT 1')
      return { status: 'succeeded' }
    } catch (err) {
      return { status: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Run `CREATE SCHEMA IF NOT EXISTS` for the configured schema. */
  private async ensureSchema(): Promise<void> {
    await this.writer.query(`CREATE SCHEMA IF NOT EXISTS "${this.config.schema}"`)
  }

  /** Run `CREATE TABLE IF NOT EXISTS` with the raw JSON column pattern. */
  private async ensureTable(streamName: string): Promise<void> {
    const schema = this.config.schema
    await this.writer.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."${streamName}" (
        "_raw_data" jsonb NOT NULL,
        "id" text GENERATED ALWAYS AS (("_raw_data"->>'id')::text) STORED,
        "_last_synced_at" timestamptz,
        "_account_id" text,
        PRIMARY KEY ("id")
      )
    `)
  }

  async *write(params: {
    config: Record<string, unknown>
    catalog: ConfiguredCatalog
    messages: AsyncIterable<DestinationInput>
  }): AsyncIterable<DestinationOutput> {
    const { messages } = params
    // Per-stream state: whether table has been created and buffered records
    const tableCreated = new Set<string>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBuffers = new Map<string, Record<string, any>[]>()

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await this.writer.upsertMany(buffer, streamName)
      streamBuffers.set(streamName, [])
    }

    const flushAll = async () => {
      for (const streamName of streamBuffers.keys()) {
        await flushStream(streamName)
      }
    }

    try {
      // Ensure schema exists before processing any messages
      await this.ensureSchema()

      for await (const msg of messages) {
        if (msg.type === 'record') {
          const { stream, data } = msg

          // First record for this stream — ensure table exists
          if (!tableCreated.has(stream)) {
            await this.ensureTable(stream)
            tableCreated.add(stream)
            streamBuffers.set(stream, [])
          }

          // Buffer the record
          const buffer = streamBuffers.get(stream)!
          buffer.push(data as Record<string, unknown>)

          // Flush when batch is full
          if (buffer.length >= this.batchSize) {
            await flushStream(stream)
          }
        } else if (msg.type === 'state') {
          // Flush the stream's pending rows, then re-emit the state checkpoint
          await flushStream(msg.stream)
          yield msg
        }
      }

      // Flush any remaining rows
      await flushAll()
    } catch (err: unknown) {
      // Attempt to flush what we have before yielding the error
      try {
        await flushAll()
      } catch {
        // ignore flush errors during error handling
      }

      const errorMsg: ErrorMessage = {
        type: 'error',
        failure_type: isTransient(err) ? 'transient_error' : 'system_error',
        message: err instanceof Error ? err.message : String(err),
        stack_trace: err instanceof Error ? err.stack : undefined,
      }
      yield errorMsg
    } finally {
      await this.writer.close()
    }

    const logMsg: LogMessage = {
      type: 'log',
      level: 'info',
      message: `Postgres destination: wrote to schema "${this.config.schema}"`,
    }
    yield logMsg
  }
}

/** Check if an error looks transient (connection refused, timeout, etc.). */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('connection')
}
