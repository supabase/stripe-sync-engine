import { describe, expect, it } from 'vitest'
import { validateQueryAgainstOpenApi } from '../openapi/filters.js'
import type { EndpointQueryParam } from '../openapi/endpoints.js'

describe('validateQueryAgainstOpenApi', () => {
  it('accepts object-style nested filters and scalar filters', () => {
    const params: EndpointQueryParam[] = [
      {
        name: 'created',
        required: false,
        schema: {
          type: 'object',
          properties: {
            gt: { type: 'integer' },
            lte: { type: 'integer' },
          },
        },
      },
      { name: 'limit', required: false, schema: { type: 'integer' } },
    ]

    const validated = validateQueryAgainstOpenApi(
      new URLSearchParams([
        ['created[gt]', '1000'],
        ['limit', '10'],
      ]),
      params
    )
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.forward.get('created[gt]')).toBe('1000')
    expect(validated.forward.get('limit')).toBe('10')
  })

  it('unwraps anyOf to find object properties', () => {
    const params: EndpointQueryParam[] = [
      {
        name: 'created',
        required: false,
        schema: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                gt: { type: 'integer' },
                gte: { type: 'integer' },
                lt: { type: 'integer' },
                lte: { type: 'integer' },
              },
            },
          ],
        } as any,
      },
      { name: 'limit', required: false, schema: { type: 'integer' } },
    ]

    const validated = validateQueryAgainstOpenApi(
      new URLSearchParams([
        ['created[gte]', '1000'],
        ['created[lt]', '2000'],
        ['limit', '10'],
      ]),
      params
    )
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.forward.get('created[gte]')).toBe('1000')
    expect(validated.forward.get('created[lt]')).toBe('2000')
  })

  it('rejects unknown filters with allowed list', () => {
    const params: EndpointQueryParam[] = [
      { name: 'limit', required: false, schema: { type: 'integer' } },
    ]

    const validated = validateQueryAgainstOpenApi(new URLSearchParams([['foo', 'bar']]), params)
    expect(validated.ok).toBe(false)
    if (validated.ok) return
    expect(validated.statusCode).toBe(400)
    expect(validated.allowed).toEqual(['limit'])
  })
})
