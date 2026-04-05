/**
 * Minimal Zod schemas for the Stripe API endpoints used by source-stripe.
 *
 * These cover only the operational endpoints (account, events, webhooks) —
 * the data-plane list/retrieve flows as untyped JSON through
 * buildListFn/buildRetrieveFn.
 *
 * If openapi-typescript ever handles the 10.5 MB Stripe spec without
 * stack overflow, these can be replaced with generated types.
 */
import { z } from 'zod'

// MARK: - Generic list wrapper

export const StripeApiListSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    object: z.literal('list'),
    data: z.array(itemSchema),
    has_more: z.boolean(),
    url: z.string(),
  })

export type StripeApiList<T> = {
  object: 'list'
  data: T[]
  has_more: boolean
  url: string
}

// MARK: - Account

export const StripeAccountSchema = z.object({
  id: z.string(),
  object: z.literal('account'),
  created: z.number().optional(),
})

export type StripeAccount = z.infer<typeof StripeAccountSchema>

// MARK: - Webhook endpoint

export const StripeWebhookEndpointSchema = z.object({
  id: z.string(),
  object: z.literal('webhook_endpoint'),
  url: z.string(),
  status: z.string(),
  enabled_events: z.array(z.string()),
  secret: z.string().optional(),
  metadata: z.record(z.string(), z.string()).nullable(),
})

export type StripeWebhookEndpoint = z.infer<typeof StripeWebhookEndpointSchema>

// MARK: - API error

export const StripeApiErrorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
    code: z.string().optional(),
    param: z.string().optional(),
  }),
})

export type StripeApiErrorBody = z.infer<typeof StripeApiErrorSchema>
