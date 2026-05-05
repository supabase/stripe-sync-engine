import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

const baseConfigFields = {
  schema: z.string().default('public').describe('Schema containing the source table'),
  primary_key: z
    .array(z.string())
    .min(1)
    .default(['id'])
    .describe('Columns that uniquely identify a row in this stream'),
  cursor_field: z.string().describe('Monotonic column used for incremental reads'),
  page_size: z.number().int().positive().default(100).describe('Rows to read per page'),
  ssl_ca_pem: z
    .string()
    .optional()
    .describe(
      'PEM-encoded CA certificate for SSL verification (required for verify-ca / verify-full with a private CA)'
    ),
}

const urlConfigFields = {
  url: z.string().describe('Postgres connection string'),
  connection_string: z.string().optional().describe('Deprecated alias for url; prefer url'),
}

const connectionStringConfigFields = {
  url: z.string().optional().describe('Postgres connection string'),
  connection_string: z.string().describe('Deprecated alias for url; prefer url'),
}

const tableConfigFields = {
  table: z.string().describe('Table to read from'),
  query: z.never().optional(),
  stream: z
    .string()
    .optional()
    .describe('Stream name emitted in the catalog and records. Defaults to table name.'),
}

const queryConfigFields = {
  table: z.never().optional(),
  query: z
    .string()
    .describe('SQL query to read from. Must expose the primary_key and cursor_field columns.'),
  stream: z.string().describe('Stream name emitted in the catalog and records.'),
}

export const configSchema = z.union([
  z.object({ ...baseConfigFields, ...urlConfigFields, ...tableConfigFields }),
  z.object({ ...baseConfigFields, ...connectionStringConfigFields, ...tableConfigFields }),
  z.object({ ...baseConfigFields, ...urlConfigFields, ...queryConfigFields }),
  z.object({ ...baseConfigFields, ...connectionStringConfigFields, ...queryConfigFields }),
])

export type Config = z.infer<typeof configSchema>

export const streamStateSpec = z.object({
  cursor: z.unknown().describe('Last emitted cursor_field value.'),
  primary_key: z.array(z.unknown()).describe('Last emitted primary key tuple at the cursor.'),
})

export type StreamState = z.infer<typeof streamStateSpec>

export default {
  config: z.toJSONSchema(configSchema),
  source_state_stream: z.toJSONSchema(streamStateSpec),
} satisfies ConnectorSpecification
