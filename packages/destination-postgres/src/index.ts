import pg from 'pg'
import type { PoolConfig } from 'pg'
import type { Destination, DestinationInput, LogMessage } from '@stripe/sync-protocol'
import {
  sql,
  sslConfigFromConnectionString,
  stripSslParams,
  upsert,
  withPgConnectProxy,
  withQueryLogging,
} from '@stripe/sync-util-postgres'
import { buildCreateTableDDL } from './schemaProjection.js'
import defaultSpec from './spec.js'
import type { Config } from './spec.js'

function logMsg(message: string, level: LogMessage['log']['level'] = 'info'): LogMessage {
  return { type: 'log', log: { level, message } }
}

// MARK: - Spec

export { configSchema, type Config } from './spec.js'

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
      connectionString: stripSslParams(connStr),
      ssl: sslConfigFromConnectionString(connStr, { sslCaPem: config.ssl_ca_pem }),
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
  entries: Record<string, any>[],
  primaryKeyColumns: string[] = ['id']
): Promise<void> {
  if (!entries.length) return
  await upsert(
    pool,
    entries.map((e) => ({ _raw_data: e })),
    {
      schema,
      table,
      primaryKeyColumns,
    }
  )
}

// MARK: - Named exports

// Schema projection (JSON Schema -> Postgres DDL)
export {
  buildCreateTableDDL,
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
  const code = ((err as NodeJS.ErrnoException).code ?? '').toLowerCase()
  return (
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('connection') ||
    code.includes('econnrefused') ||
    code.includes('etimedout') ||
    code.includes('econnreset')
  )
}

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.message) return err.message
  return (err as NodeJS.ErrnoException).code ?? err.constructor.name
}

function createPool(config: PoolConfig): pg.Pool {
  const pool = new pg.Pool(config)
  // Destination connectors should surface pool failures without crashing the host process.
  pool.on('error', (err) => {
    console.error('Postgres destination pool error:', err)
  })
  return pool
}

const destination = {
  async *spec() {
    yield { type: 'spec' as const, spec: defaultSpec }
  },

  async *check({ config }) {
    const pool = withQueryLogging(createPool(await buildPoolConfig(config)))
    try {
      await pool.query('SELECT 1')
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'succeeded' as const },
      }
    } catch (err) {
      yield {
        type: 'connection_status' as const,
        connection_status: {
          status: 'failed' as const,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      await pool.end()
    }
  },

  async *setup({ config, catalog }) {
    const pool = withQueryLogging(createPool(await buildPoolConfig(config)))
    try {
      yield logMsg(`Creating schema "${config.schema}" (${catalog.streams.length} streams)`)
      await pool.query(sql`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`)
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
      await Promise.all(
        catalog.streams.map(async (cs) => {
          await pool.query(
            buildCreateTableDDL(config.schema, cs.stream.name, cs.stream.json_schema ?? {}, {
              system_columns: cs.system_columns,
              primary_key: cs.stream.primary_key,
            })
          )
        })
      )
    } finally {
      await pool.end()
    }
  },

  async *teardown({ config }) {
    const PROTECTED_SCHEMAS = new Set(['public', 'information_schema', 'pg_catalog', 'pg_toast'])
    if (PROTECTED_SCHEMAS.has(config.schema)) {
      throw new Error(
        `Refusing to drop protected schema "${config.schema}" — teardown only drops user-created schemas`
      )
    }
    const pool = withQueryLogging(createPool(await buildPoolConfig(config)))
    try {
      await pool.query(sql`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  },

  async *write({ config, catalog }, $stdin) {
    const pool = withQueryLogging(createPool(await buildPoolConfig(config)))
    const batchSize = config.batch_size
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const streamBuffers = new Map<string, Record<string, any>[]>()
    const streamKeyColumns = new Map(
      catalog.streams.map((cs) => [
        cs.stream.name,
        cs.stream.primary_key?.map((pk) => pk[0]) ?? ['id'],
      ])
    )

    const flushStream = async (streamName: string) => {
      const buffer = streamBuffers.get(streamName)
      if (!buffer || buffer.length === 0) return
      await upsertMany(
        pool,
        config.schema,
        streamName,
        buffer,
        streamKeyColumns.get(streamName) ?? ['id']
      )
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
          const { stream, data } = msg.record

          if (!streamBuffers.has(stream)) {
            streamBuffers.set(stream, [])
          }

          const buffer = streamBuffers.get(stream)!
          buffer.push(data as Record<string, unknown>)

          if (buffer.length >= batchSize) {
            await flushStream(stream)
          }
        } else if (msg.type === 'source_state') {
          if (msg.source_state.state_type !== 'global') {
            await flushStream(msg.source_state.stream)
          }
          yield msg
        }
      }

      await flushAll()

      yield {
        type: 'log' as const,
        log: {
          level: 'info' as const,
          message: `Postgres destination: wrote to schema "${config.schema}"`,
        },
      }
    } catch (err: unknown) {
      try {
        await flushAll()
      } catch {
        // ignore flush errors during error handling
      }

      yield { type: 'log' as const, log: { level: 'error' as const, message: errorMessage(err) } }
      yield {
        type: 'connection_status' as const,
        connection_status: { status: 'failed' as const, message: errorMessage(err) },
      }
      throw err
    } finally {
      await pool.end()
    }
  },
} satisfies Destination<Config>

export default destination
