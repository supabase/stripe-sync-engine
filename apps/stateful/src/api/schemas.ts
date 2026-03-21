import { z } from '@hono/zod-openapi'

// Re-export non-connector-specific schemas from the library
export { UpdateCredentialSchema } from '@stripe/stateful-sync'

// ── HTTP-layer response helpers ─────────────────────────────────

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
