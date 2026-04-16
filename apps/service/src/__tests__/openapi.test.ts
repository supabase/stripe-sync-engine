import { describe, it, expect } from 'vitest'
import { validate } from '@hyperjump/json-schema/openapi-3-1'
import type { Json } from '@hyperjump/json-pointer'
import serviceSpec from '../__generated__/openapi.json' with { type: 'json' }

describe('Service OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const output = await validate(
      'https://spec.openapis.org/oas/3.1/schema-base',
      serviceSpec as unknown as Json
    )
    const errors = !output.valid
      ? (output.errors
          ?.map((e) => `${e.instanceLocation}: ${e.absoluteKeywordLocation}`)
          .join('\n') ?? '')
      : ''
    expect(output.valid, errors).toBe(true)
  })
})
