import { describe, expect, it } from 'vitest'
import { cleanOpenApiSpec } from '../specCleaning'
import { rawMinimalStripeOpenApiSpec } from './fixtures/minimalSpec'

describe('cleanOpenApiSpec', () => {
  it('strips deprecated GET operations while preserving other methods on the same path', () => {
    const specWithPost = {
      ...rawMinimalStripeOpenApiSpec,
      paths: {
        ...rawMinimalStripeOpenApiSpec.paths,
        '/v1/recipients': {
          ...rawMinimalStripeOpenApiSpec.paths!['/v1/recipients'],
          post: {
            responses: {
              '200': {},
            },
          },
        },
      },
    }

    const cleaned = cleanOpenApiSpec(specWithPost)

    expect(cleaned.paths?.['/v1/recipients']).toEqual({
      post: {
        responses: {
          '200': {},
        },
      },
    })
    expect(cleaned.paths?.['/v1/exchange_rates']).toBeUndefined()
    expect(cleaned.paths?.['/v1/deprecated_widgets']).toBeUndefined()
    expect(cleaned.paths?.['/v1/customers']).toBeDefined()
    expect(specWithPost.paths?.['/v1/recipients']?.get).toBeDefined()
  })
})
