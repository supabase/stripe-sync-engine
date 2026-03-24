import { z } from '@hono/zod-openapi'

// Re-export non-connector-specific schemas from the library
export { UpdateCredentialSchema } from '@tx-stripe/stateful-sync'

// ── HTTP-layer response helpers ─────────────────────────────────

const ConnectorCheckSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  message: z.string().optional(),
})

export const CheckResultSchema = z.object({
  source: ConnectorCheckSchema,
  destination: ConnectorCheckSchema,
})

export const NdjsonSchema = z.string().openapi({
  description: 'Newline-delimited JSON sync messages, one per line',
  example: '{"type":"record","stream":"products","data":{"id":"prod_123","name":"Widget"}}\n',
})

export const DeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
})

export const ErrorSchema = z.object({
  error: z.unknown(),
})

export function ListResponse<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    has_more: z.boolean(),
  })
}
