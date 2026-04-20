import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OpenAPIHono, createRoute } from '../index.js'

// ── Helpers ──────────────────────────────────────────────────────

const jsonParse = (s: string, ctx: z.RefinementCtx) => {
  try {
    return JSON.parse(s)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid JSON' })
    return z.NEVER
  }
}

const ItemSchema = z
  .object({
    name: z.string(),
    count: z.number(),
  })
  .meta({ id: 'Item' })

function createTestApp() {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues }, 400)
      }
    },
  })

  app.openapi(
    createRoute({
      operationId: 'test_json_header',
      method: 'post',
      path: '/test',
      summary: 'Test JSON content header',
      requestParams: {
        header: z.object({
          'x-data': z
            .string()
            .transform(jsonParse)
            .pipe(ItemSchema)
            .meta({ param: { content: { 'application/json': {} } } }),
        }),
      },
      responses: {
        200: {
          description: 'ok',
          content: { 'application/json': { schema: z.object({ received: ItemSchema }) } },
        },
      },
    }),
    (c) => {
      const data = c.req.valid('header')['x-data']
      return c.json({ received: data }, 200)
    }
  )

  return app
}

// ── Runtime validation tests ─────────────────────────────────────

describe('JSON content header — runtime', () => {
  it('validates and parses JSON header into typed object', async () => {
    const app = createTestApp()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'x-data': JSON.stringify({ name: 'widget', count: 5 }) },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.received).toEqual({ name: 'widget', count: 5 })
  })

  it('rejects invalid JSON with 400', async () => {
    const app = createTestApp()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'x-data': 'not-json' },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'Invalid JSON' })])
    )
  })

  it('rejects JSON that fails pipe schema with 400', async () => {
    const app = createTestApp()
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'x-data': JSON.stringify({ name: 123 }) },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['x-data', 'name'] })])
    )
  })

  it('handles optional JSON header — omitted', async () => {
    const app = new OpenAPIHono({
      defaultHook: (result, c) => {
        if (!result.success) return c.json({ error: result.error.issues }, 400)
      },
    })

    app.openapi(
      createRoute({
        operationId: 'test_optional',
        method: 'post',
        path: '/opt',
        summary: 'Optional JSON header',
        requestParams: {
          header: z.object({
            'x-data': z
              .string()
              .transform(jsonParse)
              .pipe(ItemSchema)
              .optional()
              .meta({ param: { content: { 'application/json': {} } } }),
          }),
        },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => {
        const data = c.req.valid('header')['x-data']
        return c.json({ present: data !== undefined, data }, 200)
      }
    )

    const res = await app.request('/opt', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.present).toBe(false)
  })

  it('validates mixed plain + JSON content headers', async () => {
    const app = new OpenAPIHono({
      defaultHook: (result, c) => {
        if (!result.success) return c.json({ error: result.error.issues }, 400)
      },
    })

    app.openapi(
      createRoute({
        operationId: 'test_mixed',
        method: 'post',
        path: '/mixed',
        summary: 'Mixed headers',
        requestParams: {
          header: z.object({
            'x-api-key': z.string(),
            'x-data': z
              .string()
              .transform(jsonParse)
              .pipe(ItemSchema)
              .meta({ param: { content: { 'application/json': {} } } }),
          }),
        },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => {
        const headers = c.req.valid('header')
        return c.json({ key: headers['x-api-key'], data: headers['x-data'] }, 200)
      }
    )

    const res = await app.request('/mixed', {
      method: 'POST',
      headers: {
        'x-api-key': 'secret',
        'x-data': JSON.stringify({ name: 'test', count: 1 }),
      },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.key).toBe('secret')
    expect(body.data).toEqual({ name: 'test', count: 1 })
  })
})

// ── OAS spec generation tests ────────────────────────────────────

describe('JSON content header — OAS spec', () => {
  it('generates content encoding for annotated header params', async () => {
    const app = createTestApp()
    const spec = app.getOpenAPI31Document({
      info: { title: 'test', version: '1' },
    }) as any

    const params = spec.paths['/test'].post.parameters
    const xData = params.find((p: any) => p.name === 'x-data')

    expect(xData).toBeDefined()
    expect(xData.in).toBe('header')
    expect(xData.required).toBe(true)
    // Must have content, NOT schema
    expect(xData.content).toBeDefined()
    expect(xData.schema).toBeUndefined()
    expect(xData.content['application/json']).toBeDefined()
    expect(xData.content['application/json'].schema).toBeDefined()
  })

  it('plain headers still use schema (not content)', async () => {
    const app = new OpenAPIHono()
    app.openapi(
      createRoute({
        operationId: 'plain',
        method: 'get',
        path: '/plain',
        summary: 'Plain header',
        requestParams: {
          header: z.object({ 'x-token': z.string() }),
        },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.json({}, 200)
    )

    const spec = app.getOpenAPI31Document({
      info: { title: 'test', version: '1' },
    }) as any

    const params = spec.paths['/plain'].get.parameters
    const xToken = params.find((p: any) => p.name === 'x-token')
    expect(xToken.schema).toBeDefined()
    expect(xToken.content).toBeUndefined()
  })

  it('$ref components from .meta({ id }) appear in the spec', async () => {
    const app = createTestApp()
    const spec = app.getOpenAPI31Document({
      info: { title: 'test', version: '1' },
    }) as any

    // Item schema should appear as a named component
    expect(spec.components?.schemas?.Item).toBeDefined()
    expect(spec.components.schemas.Item.properties.name).toEqual({ type: 'string' })
    expect(spec.components.schemas.Item.properties.count).toEqual({ type: 'number' })

    // The header content schema should use $ref
    const params = spec.paths['/test'].post.parameters
    const xData = params.find((p: any) => p.name === 'x-data')
    expect(xData.content['application/json'].schema.$ref).toBe('#/components/schemas/Item')
  })
})
