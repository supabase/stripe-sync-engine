import pg from 'pg'
import { z } from 'zod'
import type { PoolConfig } from 'pg'
import type { Destination, DestinationInput, ErrorMessage, LogMessage } from '@stripe/sync-protocol'
import { sql, upsert, withPgConnectProxy } from '@stripe/sync-util-postgres'
import { buildCreateTableWithSchema, runSqlAdditive } from './schemaProjection.js'

// MARK: - Spec

export const spec = z.object({
  url: z.string().optional().describe('Postgres connection string (alias for connection_string)'),
  connection_string: z.string().optional().describe('Postgres connection string'),
  host: z.string().optional().describe('Postgres host (required for AWS IAM)'),
  port: z.number().default(5432).describe('Postgres port'),
  database: z.string().optional().describe('Database name (required for AWS IAM)'),
  user: z.string().optional().describe('Database user (required for AWS IAM)'),
  schema: z.string().describe('Target schema name'),
  batch_size: z.number().default(100).describe('Records to buffer before flushing'),
  aws: z
    .object({
      region: z.string().describe('AWS region for RDS instance'),
      role_arn: z.string().optional().describe('IAM role ARN to assume (cross-account)'),
      external_id: z.string().optional().describe('External ID for STS AssumeRole'),
    })
    .optional()
    .describe('AWS RDS IAM authentication config'),
})

export type Config = z.infer<typeof spec>

export async function buildPoolConfig(config: Config): Promise<PoolConfig> {
  if (config.aws) {
    if (!config.host || !config.database || !config.user) {
      throw new Error('host, database, and user are required when using AWS IAM auth')
    }
    const { buildRdsIamPasswordFn } = await import('./aws.js')
    const passwordFn = await buildRdsIamPasswordFn({
      host: config.host,
      port: config.port,
      user: config.user,
      region: config.aws.region,
      roleArn: config.aws.role_arn,
      externalId: config.aws.external_id,
    })
    return withPgConnectProxy({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: passwordFn,
      ssl: true,
    })
  }

  const connStr = config.connection_string ?? config.url
  if (connStr) {
    return withPgConnectProxy({
      connectionString: connStr,
      // TODO: Preserve connection-string sslmode semantics here instead of forcing TLS.
      ssl: { rejectUnauthorized: false },
    })
  }

  throw new Error('Either connection_string (or url) or aws config is required')
}

// MARK: - upsertMany

/**
 * Upsert records into a Postgres table using the _raw_data jsonb pattern.
 * Delegates to util-postgres `upsert()` which batches all rows into a single
 * multi-row INSERT ... ON CONFLICT statement.
 */
export async function upsertMany(
  pool: pg.Pool,
  schema: string,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entries: Record<string, any>[]
): Promise<void> {
  if (!entries.length) return
  await upsert(
    pool,
    entries.map((e) => ({ _raw_data: e })),
    {
      schema,
      table,
      keyColumns: ['id'],
    }
  )
}

// MARK: - Named exports

// Schema projection (JSON Schema -> Postgres DDL)
export {
  buildCreateTableWithSchema,
  jsonSchemaToColumns,
  runSqlAdditive,
  applySchemaFromCatalog,
  type ApplySchemaFromCatalogConfig,
  type BuildTableOptions,
  type SystemColumn,
} from './schemaProjection.js'

// MARK: - Default export

/** Check if an error looks transient (connection refused, timeout, etc.). */
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('econnrefused') || msg.includes('timeout') || msg.includes('connection')
}

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    const pool = new pg.Pool(await buildPoolConfig(config))
    try {
      await pool.query('SELECT 1')
      return { status: 'succeeded' as const }
    } catch (err) {
      return {
        status: 'failed' as const,
        message: err instanceof Error ? err.message : String(err),
      }
    } finally {
      await pool.end()
    }
  },

  async setup({ config, catalog }) {
    const pool = new pg.Pool(await buildPoolConfig(config))
    try {
      await pool.query(sql`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)
      // Ensure the trigger function exists in the target schema so triggers
      // can reference it without relying on search_path.
      await pool.query(sql`
        CREATE OR REPLACE FUNCTION "${config.schema}".set_updated_at() RETURNS trigger
            LANGUAGE plpgsql
        AS $$
        BEGIN
          NEW := jsonb_populate_record(
            NEW,
            jsonb_build_object('updated_at', now(), '_updated_at', now())
          );
          RETURN NEW;
        END;
        $$;
      `)
      for (const cs of catalog.streams) {
        if (cs.stream.json_schema) {
          for (const stmt of buildCreateTableWithSchema(
            config.schema,
            cs.stream.name,
            cs.stream.json_schema,
            {
              system_columns: cs.system_columns,
            }
          )) {
            await runSqlAdditive(pool, stmt)
          }
        } else {
          await pool.query(sql`
            CREATE TABLE IF NOT EXISTS "${config.schema}"."${cs.stream.name}" (
              "_raw_data" jsonb NOT NULL,
              "_last_synced_at" timestamptz,
              "_updated_at" timestamptz NOT NULL DEFAULT now(),
              "id" text GENERATED ALWAYS AS (("_raw_data"->>'id')::text) STORED,
              PRIMARY KEY ("id")
            )
          `)
        }
      }
    } finally {
      await pool.end()
    }
  },

  async teardown({ config }) {
    const pool = new pg.Pool(await buildPoolConfig(config))
    try {
      await pool.query(sql`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  },

  async *write({ config, catalog }, $stdin) {
    const pool = new pg.Pool(await buildPoolConfig(config))
    const batchSize = config.batch_size
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBuffers = new Map<string, Record<string, any>[]>()

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await upsertMany(pool, config.schema, streamName, buffer)
      streamBuffers.set(streamName, [])
    }

    const flushAll = async () => {
      for (const streamName of streamBuffers.keys()) {
        await flushStream(streamName)
      }
    }

    try {
      for await (const msg of $stdin as AsyncIterable<DestinationInput>) {
        if (msg.type === 'record') {
          const { stream, data } = msg

          if (!streamBuffers.has(stream)) {
            streamBuffers.set(stream, [])
          }

          const buffer = streamBuffers.get(stream)!
          buffer.push(data as Record<string, unknown>)

          if (buffer.length >= batchSize) {
            await flushStream(stream)
          }
        } else if (msg.type === 'state') {
          await flushStream(msg.stream)
          yield msg
        }
      }

      await flushAll()
    } catch (err: unknown) {
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
      await pool.end()
    }

    const logMsg: LogMessage = {
      type: 'log',
      level: 'info',
      message: `Postgres destination: wrote to schema "${config.schema}"`,
    }
    yield logMsg
  },
} satisfies Destination<Config>

export default destination
