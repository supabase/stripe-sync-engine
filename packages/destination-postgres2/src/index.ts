import { z } from 'zod'
import pg from 'pg'
import type {
  CatalogMessage,
  ConnectorSpecification,
  Destination,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'

// MARK: - Spec

export const spec = z.object({
  connectionString: z.string().describe('Postgres connection string'),
  schema: z.string().default('public').describe('Target schema name'),
})

export type Config = z.infer<typeof spec>

// MARK: - Helpers

/** Escape a Postgres identifier (schema/table name). */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Extract primary key value from a record.
 * Supports composite keys — concatenates with `:` separator.
 */
function extractPk(data: Readonly<Record<string, unknown>>, primaryKey: string[][]): string {
  return primaryKey.map((path) => String(data[path[0]!])).join(':')
}

// MARK: - Destination

const destination: Destination<Config> = {
  spec(): ConnectorSpecification {
    return { connection_specification: z.toJSONSchema(spec) }
  },

  async check(config) {
    const pool = new pg.Pool({ connectionString: config.connectionString })
    try {
      await pool.query('SELECT 1')
      return { status: 'succeeded' }
    } catch (err: any) {
      return { status: 'failed', message: err.message }
    } finally {
      await pool.end()
    }
  },

  async *write(
    config,
    catalog: CatalogMessage,
    messages: AsyncIterableIterator<DestinationInput>
  ): AsyncIterableIterator<DestinationOutput> {
    const pool = new pg.Pool({ connectionString: config.connectionString })
    const schema = config.schema ?? 'public'

    // Build a lookup from stream name → primary key paths
    const streamPks = new Map<string, string[][]>()
    for (const stream of catalog.streams) {
      streamPks.set(stream.name, stream.primary_key)
    }

    // Track which tables we've auto-created
    const createdTables = new Set<string>()

    try {
      for await (const msg of messages) {
        if (msg.type === 'state') {
          // Passthrough — the orchestrator persists this as a checkpoint
          yield msg
          continue
        }

        // msg.type === 'record'
        const table = msg.stream
        const pk = streamPks.get(table)

        if (!pk?.length) {
          yield {
            type: 'error',
            failure_type: 'config_error',
            message: `Stream "${table}" not in catalog or has no primary key`,
            stream: table,
          }
          continue
        }

        // Auto-create table on first record
        if (!createdTables.has(table)) {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS ${ident(schema)}.${ident(table)} (
              _pk TEXT PRIMARY KEY,
              data JSONB NOT NULL
            )
          `)
          createdTables.add(table)
        }

        // Upsert
        const pkValue = extractPk(msg.data, pk)
        await pool.query(
          `INSERT INTO ${ident(schema)}.${ident(table)} (_pk, data)
           VALUES ($1, $2)
           ON CONFLICT (_pk) DO UPDATE SET data = EXCLUDED.data`,
          [pkValue, JSON.stringify(msg.data)]
        )
      }
    } catch (err: any) {
      yield {
        type: 'error',
        failure_type: 'system_error',
        message: err.message,
        stack_trace: err.stack,
      }
    } finally {
      await pool.end()
    }
  },
}

export default destination
