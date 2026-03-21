import { z } from 'zod'
import type { PoolConfig } from 'pg'
import type { Destination } from '@stripe/protocol'
import { PostgresDestination } from './postgresDestination'

// MARK: - Spec

export const spec = z.object({
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
    const { buildRdsIamPasswordFn } = await import('./aws')
    const passwordFn = await buildRdsIamPasswordFn({
      host: config.host,
      port: config.port,
      user: config.user,
      region: config.aws.region,
      roleArn: config.aws.role_arn,
      externalId: config.aws.external_id,
    })
    return {
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: passwordFn,
      ssl: true,
    }
  }

  if (config.connection_string) {
    return { connectionString: config.connection_string }
  }

  throw new Error('Either connection_string or aws config is required')
}

// MARK: - Named exports

// CLI
export type { DestinationCliOptions } from './cli'
export { main as cliMain } from './cli'

export { PostgresDestination } from './postgresDestination'
export { PostgresDestinationWriter } from './writer'
export type { PostgresConfig } from './types'

// Schema projection (JSON Schema → Postgres DDL)
export {
  buildCreateTableWithSchema,
  jsonSchemaToColumns,
  runSqlAdditive,
  applySchemaFromCatalog,
  type ApplySchemaFromCatalogConfig,
  type BuildTableOptions,
  type SystemColumn,
} from './schemaProjection'

// MARK: - Default export

const destination = {
  spec() {
    return { config: z.toJSONSchema(spec) }
  },

  async check({ config }) {
    const poolConfig = await buildPoolConfig(config)
    const dest = new PostgresDestination({
      schema: config.schema,
      poolConfig,
    })
    try {
      return await dest.check({ config })
    } finally {
      await dest.close()
    }
  },

  async setup({ config, catalog }) {
    const poolConfig = await buildPoolConfig(config)
    const dest = new PostgresDestination({
      schema: config.schema,
      poolConfig,
    })
    try {
      await dest.setup({ config, catalog })
    } finally {
      await dest.close()
    }
  },

  async teardown({ config }) {
    const poolConfig = await buildPoolConfig(config)
    const dest = new PostgresDestination({
      schema: config.schema,
      poolConfig,
    })
    await dest.teardown({ config })
  },

  async *write({ config, catalog }, $stdin) {
    const poolConfig = await buildPoolConfig(config)
    const dest = new PostgresDestination({
      schema: config.schema,
      poolConfig,
      batchSize: config.batch_size,
    })
    yield* dest.write({ config, catalog }, $stdin)
  },
} satisfies Destination<Config>

export default destination
