import { z } from 'zod'

export const configSchema = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  account_id: z.string().optional().describe('Stripe account ID (resolved from API if omitted)'),
  livemode: z.boolean().optional().describe('Whether this is a live mode sync'),
  api_version: z.string().optional().describe('Stripe API version (e.g. 2025-04-30.basil)'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for stripe-mock)'),
  webhook_url: z
    .string()
    .url()
    .optional()
    .describe('URL for managed webhook endpoint registration'),
  webhook_secret: z
    .string()
    .optional()
    .describe('Webhook signing secret (whsec_...) for signature verification'),
  websocket: z.boolean().optional().describe('Enable WebSocket streaming for live events'),
  poll_events: z
    .boolean()
    .optional()
    .describe('Enable events API polling for incremental sync after backfill'),
  webhook_port: z
    .number()
    .int()
    .optional()
    .describe('Port for built-in webhook HTTP listener (e.g. 4242)'),
  revalidate_objects: z
    .array(z.string())
    .optional()
    .describe('Object types to re-fetch from Stripe API on webhook (e.g. ["subscription"])'),
  backfill_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max objects to backfill per stream (useful for testing)'),
  rate_limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Max Stripe API requests per second (default: 25)'),
  backfill_concurrency: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Number of time-range segments for parallel backfill (default: 200)'),
})

export type Config = z.infer<typeof configSchema>
