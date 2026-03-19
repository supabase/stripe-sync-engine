import { z } from 'zod'
import pg from 'pg'
import type {
  ConfiguredCatalog,
  Destination,
  DestinationInput,
  DestinationOutput,
} from '@stripe/sync-protocol'

// MARK: - Spec

export const spec = z.object({
  connection_string: z.string().describe('Postgres connection string'),
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

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    const pool = new pg.Pool({ connectionString: config.connection_string })
    try {
      await pool.query('SELECT 1')
      return { status: 'succeeded' as const }
    } catch (err: any) {
      return { status: 'failed' as const, message: err.message }
    } finally {
      await pool.end()
    }
  },

  async *write({ config, catalog }, $stdin) {
    const pool = new pg.Pool({ connectionString: config.connection_string })
    const schema = config.schema ?? 'public'

    // Build a lookup from stream name → primary key paths
    const streamPks = new Map<string, string[][]>()
    for (const cs of catalog.streams) {
      streamPks.set(cs.stream.name, cs.stream.primary_key)
    }

    // Track which tables we've auto-created
    const createdTables = new Set<string>()

    try {
      for await (const msg of $stdin) {
        if (msg.type === 'state') {
          // Passthrough — the orchestrator persists this as a checkpoint
          yield msg
          continue
        }
        if (msg.type !== 'record') continue // skip non-data messages (e.g. stream_status)

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
} satisfies Destination<Config>

export default destination
