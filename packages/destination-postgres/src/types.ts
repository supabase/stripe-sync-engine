import { PoolConfig } from 'pg'

export type PostgresConfig = {
  schema: string
  /** Schema for metadata tables (accounts, _sync_runs, etc.). Defaults to schema when not provided. */
  syncSchema?: string
  poolConfig: PoolConfig
  /** Number of records to buffer before flushing to the database. Default: 100. */
  batchSize?: number
}
