import { z } from 'zod'
import type { ConnectorSpecification } from '@stripe/sync-protocol'
import { SUPPORTED_API_VERSIONS } from '@stripe/sync-openapi'

const customObjectStreamConfigSchema = z
  .object({
    plural_name: z.string().describe('Stripe Custom Object api_name_plural'),
    field_mapping: z
      .record(z.string(), z.string())
      .describe('Mapping from Custom Object field names to source record fields.'),
  })
  .strict()

const standardObjectStreamConfigSchema = z
  .object({
    field_mapping: z
      .record(z.string(), z.string())
      .describe('Mapping from Stripe create parameter names to source record fields.'),
  })
  .strict()

const baseConfigSchema = z.object({
  api_key: z.string().describe('Stripe API key (sk_test_... or sk_live_...)'),
  base_url: z
    .string()
    .url()
    .optional()
    .describe('Override the Stripe API base URL (e.g. http://localhost:12111 for tests)'),
  max_retries: z
    .number()
    .int()
    .nonnegative()
    .default(3)
    .describe('Retries for 429/5xx/network errors'),
})

const customObjectConfigSchema = baseConfigSchema
  .extend({
    api_version: z
      .literal('unsafe-development')
      .describe('Stripe API version for Custom Object write requests'),
    object: z.literal('custom_object').describe('Stripe object type to write.'),
    write_mode: z.literal('create').describe('Custom Objects are append-only create writes.'),
    streams: z
      .record(z.string(), customObjectStreamConfigSchema)
      .describe('Per-source-stream Custom Object write configuration.'),
  })
  .strict()

const standardObjectConfigSchema = baseConfigSchema
  .extend({
    api_version: z.enum(SUPPORTED_API_VERSIONS).describe('Stripe API version for write requests'),
    object: z.literal('standard_object').describe('Write standard Stripe API resources.'),
    write_mode: z.literal('create').describe('Standard Stripe objects are insert-only creates.'),
    streams: z
      .record(z.string(), standardObjectStreamConfigSchema)
      .describe('Per-source-stream standard Stripe object create configuration.'),
  })
  .strict()

export const configSchema = z.discriminatedUnion('object', [
  customObjectConfigSchema,
  standardObjectConfigSchema,
])

export type Config = z.infer<typeof configSchema>
export type CustomObjectConfig = z.infer<typeof customObjectConfigSchema>
export type StandardObjectConfig = z.infer<typeof standardObjectConfigSchema>

const configJsonSchema = {
  ...z.toJSONSchema(configSchema),
  type: 'object',
  properties: {},
} as const

export default {
  config: configJsonSchema,
} satisfies ConnectorSpecification
