import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'

export const envVars = {
  client_id: 'GOOGLE_CLIENT_ID',
  client_secret: 'GOOGLE_CLIENT_SECRET',
} as const

export const configSchema = z.object({
  client_id: z.string().optional().describe('Google OAuth2 client ID (env: GOOGLE_CLIENT_ID)'),
  client_secret: z
    .string()
    .optional()
    .describe('Google OAuth2 client secret (env: GOOGLE_CLIENT_SECRET)'),
  access_token: z
    .string()
    .nullish()
    .describe('OAuth2 access token — refreshed automatically if absent'),
  refresh_token: z.string().describe('OAuth2 refresh token'),
  spreadsheet_id: z.string().optional().describe('Target spreadsheet ID (created if omitted)'),
  spreadsheet_title: z
    .string()
    .default('Stripe Sync')
    .describe('Title when creating a new spreadsheet'),
  batch_size: z.number().default(50).describe('Rows per Sheets API append call'),
})

export type Config = z.infer<typeof configSchema>

export default {
  config: z.toJSONSchema(configSchema),
  // sheet flushAll can take tens of seconds on wide catalogs; give it half the budget.
  soft_limit_fraction: 0.5,
} satisfies ConnectorSpecification
