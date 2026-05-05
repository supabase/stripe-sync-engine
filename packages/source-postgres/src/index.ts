import pg from 'pg'
import type { PoolConfig, QueryResult } from 'pg'
import type { Source, Stream } from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import {
  ident,
  qualifiedTable,
  sslConfigFromConnectionString,
  stripSslParams,
  withPgConnectProxy,
} from '@stripe/sync-util-postgres'
import defaultSpec, { type Config, type StreamState } from './spec.js'
import { log } from './logger.js'

export { configSchema, streamStateSpec, type Config, type StreamState } from './spec.js'

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>>
  end(): Promise<void>
}

export type PostgresSourceDeps = {
  createPool?: (config: Config) => Queryable | Promise<Queryable>
  now?: () => Date
}

type Row = Record<string, unknown>

const msg = createSourceMessageFactory<StreamState, Record<string, unknown>, Row>()

export async function buildPoolConfig(config: Config): Promise<PoolConfig> {
  const connectionString = config.url ?? config.connection_string
  if (!connectionString) throw new Error('Either url or connection_string is required')
  return withPgConnectProxy({
    connectionString: stripSslParams(connectionString),
    ssl: sslConfigFromConnectionString(connectionString, { sslCaPem: config.ssl_ca_pem }),
  })
}

async function createDefaultPool(config: Config): Promise<Queryable> {
  const poolConfig = await buildPoolConfig(config)
  const pool = new pg.Pool(poolConfig)
  pool.on('error', (err) => {
    log.error({ err }, 'Postgres source pool error')
  })
  return pool
}

function streamName(config: Config): string {
  return config.stream ?? config.table!
}

function sourceSql(config: Config): string {
  if (config.query) return `(${config.query}) AS source_query`
  return qualifiedTable(config.schema, config.table!)
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(serializeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        serializeValue(inner),
      ])
    )
  }
  return value
}

function serializeRow(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serializeValue(value)]))
}

function jsonTypeForPostgresType(dataType: string): Record<string, unknown> {
  switch (dataType) {
    case 'boolean':
      return { type: 'boolean' }
    case 'smallint':
    case 'integer':
      return { type: 'integer' }
    case 'bigint':
      return { type: 'string' }
    case 'real':
    case 'double precision':
      return { type: 'number' }
    case 'numeric':
      return { type: 'string' }
    case 'json':
    case 'jsonb':
      return { type: 'object' }
    case 'ARRAY':
      return { type: 'array' }
    default:
      return { type: 'string' }
  }
}

async function discoverTableSchema(
  pool: Queryable,
  config: Config
): Promise<Record<string, unknown>> {
  if (!config.table) {
    return { type: 'object', additionalProperties: true }
  }

  const result = await pool.query<{
    column_name: string
    data_type: string
    is_nullable: string
  }>(
    `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `,
    [config.schema, config.table]
  )

  if (result.rows.length === 0) {
    throw new Error(
      `Table "${config.schema}.${config.table}" was not found or has no visible columns`
    )
  }

  const properties = Object.fromEntries(
    result.rows.map((row) => {
      const schema = jsonTypeForPostgresType(row.data_type)
      return [
        row.column_name,
        row.is_nullable === 'YES' ? { anyOf: [schema, { type: 'null' }] } : schema,
      ]
    })
  )
  const required = result.rows
    .filter((row) => row.is_nullable === 'NO')
    .map((row) => row.column_name)

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: true,
  }
}

function buildPageQuery(
  config: Config,
  state: StreamState | undefined
): { text: string; values: unknown[] } {
  const cursorAndPk = [config.cursor_field, ...config.primary_key]
  const orderBy = cursorAndPk.map((column) => `${ident(column)} ASC`).join(', ')
  const values: unknown[] = []
  let where = ''

  if (state?.cursor !== undefined) {
    values.push(state.cursor, ...state.primary_key)
    const columns = `(${cursorAndPk.map(ident).join(', ')})`
    const params = `(${cursorAndPk.map((_, index) => `$${index + 1}`).join(', ')})`
    where = `WHERE ${columns} > ${params}`
  }

  values.push(config.page_size)
  const limitParam = `$${values.length}`

  return {
    text: `SELECT * FROM ${sourceSql(config)} ${where} ORDER BY ${orderBy} LIMIT ${limitParam}`,
    values,
  }
}

function nextState(config: Config, row: Row): StreamState {
  return {
    cursor: serializeValue(row[config.cursor_field]),
    primary_key: config.primary_key.map((key) => serializeValue(row[key])),
  }
}

function streamFromConfig(config: Config, jsonSchema: Record<string, unknown>): Stream {
  return {
    name: streamName(config),
    primary_key: config.primary_key.map((key) => [key]),
    json_schema: jsonSchema,
    newer_than_field: config.cursor_field,
  }
}

export function createPostgresSource(deps: PostgresSourceDeps = {}): Source<Config, StreamState> {
  const createPool = deps.createPool ?? createDefaultPool
  const now = deps.now ?? (() => new Date())

  return {
    async *spec() {
      yield { type: 'spec' as const, spec: defaultSpec }
    },

    async *check({ config }) {
      let pool: Queryable | undefined
      try {
        pool = await createPool(config)
        await pool.query('SELECT 1')
        yield msg.connection_status({ status: 'succeeded' })
      } catch (err) {
        yield msg.connection_status({
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        await pool?.end()
      }
    },

    async *discover({ config }) {
      const pool = await createPool(config)
      try {
        const jsonSchema = await discoverTableSchema(pool, config)
        yield {
          type: 'catalog' as const,
          catalog: { streams: [streamFromConfig(config, jsonSchema)] },
        }
      } finally {
        await pool.end()
      }
    },

    async *read({ config, catalog, state }) {
      const selected = new Set(catalog.streams.map((configured) => configured.stream.name))
      const name = streamName(config)
      if (!selected.has(name)) return

      const pool = await createPool(config)
      try {
        let currentState = state?.streams[name] as StreamState | undefined
        for (;;) {
          const pageQuery = buildPageQuery(config, currentState)
          const page = await pool.query<Row>(pageQuery.text, pageQuery.values)
          if (page.rows.length === 0) break

          for (const row of page.rows) {
            const serialized = serializeRow(row)
            yield msg.record({
              stream: name,
              data: serialized,
              emitted_at: now().toISOString(),
            })
            currentState = nextState(config, row)
          }

          yield msg.source_state({
            state_type: 'stream',
            stream: name,
            data: currentState!,
          })

          if (page.rows.length < config.page_size) break
        }
      } finally {
        await pool.end()
      }
    },
  }
}

export default createPostgresSource()
