import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'
import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

export const configSchema = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  account_id: z.string().optional().describe('Stripe account ID (resolved from API if omitted)'),
  livemode: z.boolean().optional().describe('Whether this is a live mode sync'),
  api_version: z
    .enum(SUPPORTED_API_VERSIONS)
    .optional()
    .describe(`Stripe API version (default: ${BUNDLED_API_VERSION})`),
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
    .describe('Number of time-range segments for parallel backfill (default: 10)'),
})

export type Config = z.infer<typeof configSchema>

const segmentStateSpec = z.object({
  index: z.number(),
  gte: z.number(),
  lt: z.number(),
  page_cursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
})

const backfillStateSpec = z.object({
  range: z.object({ gte: z.number(), lt: z.number() }),
  num_segments: z.number(),
  completed: z.array(z.object({ gte: z.number(), lt: z.number() })),
  in_flight: z.array(z.object({ gte: z.number(), lt: z.number(), page_cursor: z.string() })),
})

export const streamStateSpec = z.object({
  page_cursor: z.string().nullable(),
  status: z.enum(['pending', 'complete']),
  events_cursor: z.number().optional(),
  segments: z.array(segmentStateSpec).optional(),
  backfill: backfillStateSpec.optional(),
})

export const stripeEventSchema = z.object({
  id: z.string().describe('Unique identifier for the object.'),
  object: z
    .literal('event')
    .describe(
      "String representing the object's type. Objects of the same type share the same value."
    ),
  account: z.string().optional().describe('The connected account that originates the event.'),
  api_version: z
    .string()
    .nullable()
    .describe(
      'The Stripe API version used to render `data`. This property is populated only for events on or after October 31, 2014.'
    ),
  created: z
    .number()
    .describe('Time at which the object was created. Measured in seconds since the Unix epoch.'),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
    previous_attributes: z.record(z.string(), z.unknown()).optional(),
  }),
  livemode: z
    .boolean()
    .describe(
      'Has the value `true` if the object exists in live mode or the value `false` if the object exists in test mode.'
    ),
  pending_webhooks: z
    .number()
    .describe(
      "Number of webhooks that haven't been successfully delivered (for example, to return a 20x response) to the URLs you specify."
    ),
  request: z
    .object({
      id: z.string().nullable(),
      idempotency_key: z.string().nullable(),
    })
    .nullable()
    .describe('Information on the API request that triggers the event.'),
  type: z
    .string()
    .describe('Description of the event (for example, `invoice.created` or `charge.refunded`).'),
})

export type StripeEvent = z.infer<typeof stripeEventSchema>

export default {
  config: z.toJSONSchema(configSchema),
  source_state_stream: z.toJSONSchema(streamStateSpec),
  source_input: z.toJSONSchema(stripeEventSchema),
} satisfies ConnectorSpecification
