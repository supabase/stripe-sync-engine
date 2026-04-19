import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OpenAPIHono, createRoute } from '../index.js'

const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const ListSchema = z.object({
  data: z.array(ItemSchema),
  has_more: z.boolean(),
})

function createTestApp() {
  const app = new OpenAPIHono()

  app.openapi(
    createRoute({
      operationId: 'items.list',
      method: 'get',
      path: '/items',
      summary: 'List items',
      responses: {
        200: {
          content: { 'application/json': { schema: ListSchema } },
          description: 'List of items',
        },
      },
    }),
    (c) => {
      // Return invalid data (missing required 'name' on items)
      const query = c.req.query('mode')
      if (query === 'invalid') {
        return c.json({ data: [{ id: '1', extra: true }], has_more: false }, 200)
      }
      if (query === 'wrong-shape') {
        return c.json({ wrong: 'shape' }, 200)
      }
      return c.json({ data: [{ id: '1', name: 'Test' }], has_more: false }, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'items.get',
      method: 'get',
      path: '/items/{id}',
      summary: 'Get item',
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        200: {
          content: { 'application/json': { schema: ItemSchema } },
          description: 'Single item',
        },
        404: {
          content: {
            'application/json': { schema: z.object({ error: z.string() }) },
          },
          description: 'Not found',
        },
      },
    }),
    (c) => {
      const { id } = c.req.valid('param')
      if (id === 'missing') {
        return c.json({ error: 'Not found' }, 404)
      }
      return c.json({ id, name: 'Item' }, 200)
    }
  )

  app.openapi(
    createRoute({
      operationId: 'items.delete',
      method: 'delete',
      path: '/items/{id}',
      summary: 'Delete item',
      requestParams: { path: z.object({ id: z.string() }) },
      responses: {
        204: {
          description: 'Deleted',
        },
      },
    }),
    (c) => {
      return c.body(null, 204)
    }
  )

  return app
}

describe('response validation', () => {
  it('passes valid responses through unchanged', async () => {
    const app = createTestApp()
    const res = await app.request('/items')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ data: [{ id: '1', name: 'Test' }], has_more: false })
  })

  it('returns 500 with error details for invalid response', async () => {
    const app = createTestApp()
    const res = await app.request('/items?mode=invalid')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Response validation failed')
    expect(body.details).toBeDefined()
    expect(Array.isArray(body.details)).toBe(true)
  })

  it('returns 500 when response shape is completely wrong', async () => {
    const app = createTestApp()
    const res = await app.request('/items?mode=wrong-shape')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Response validation failed')
  })

  it('validates different status codes with their own schemas', async () => {
    const app = createTestApp()
    const res = await app.request('/items/missing')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'Not found' })
  })

  it('skips validation for 204 No Content', async () => {
    const app = createTestApp()
    const res = await app.request('/items/123', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })

  it('passes valid single-item response', async () => {
    const app = createTestApp()
    const res = await app.request('/items/abc')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ id: 'abc', name: 'Item' })
  })
})
