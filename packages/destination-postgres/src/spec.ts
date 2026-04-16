import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const configSchema = z.object({
  url: z.string().optional().describe('Postgres connection string (alias for connection_string)'),
  connection_string: z.string().optional().describe('Postgres connection string'),
  host: z.string().optional().describe('Postgres host (required for AWS IAM)'),
  port: z.number().default(5432).describe('Postgres port'),
  database: z.string().optional().describe('Database name (required for AWS IAM)'),
  user: z.string().optional().describe('Database user (required for AWS IAM)'),
  schema: z.string().describe('Target schema name (e.g. "stripe_sync")'),
  batch_size: z.number().default(100).describe('Records to buffer before flushing'),
  aws: z
    .object({
      region: z.string().describe('AWS region for RDS instance'),
      role_arn: z.string().optional().describe('IAM role ARN to assume (cross-account)'),
      external_id: z.string().optional().describe('External ID for STS AssumeRole'),
    })
    .optional()
    .describe('AWS RDS IAM authentication config'),
  ssl_ca_pem: z
    .string()
    .optional()
    .describe(
      'PEM-encoded CA certificate for SSL verification (required for verify-ca / verify-full with a private CA)'
    ),
})

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
} satisfies ConnectorSpecification
