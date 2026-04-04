import { describe, it, expect } from 'vitest'
import { validate, type OpenApi } from '@hyperjump/json-schema/openapi-3-1'
import type { Json } from '@hyperjump/json-pointer'
import { createApp, createConnectorResolver } from '../index.js'
import { defaultConnectors } from '../lib/default-connectors.js'

async function getApp() {
  const resolver = await createConnectorResolver(defaultConnectors)
  return createApp(resolver)
}

async function getSpec(): Promise<OpenApi> {
  const app = await getApp()
  const res = await app.request('/openapi.json')
  return (await res.json()) as OpenApi
}

describe('Engine OpenAPI spec', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const spec = await getSpec()
    const output = await validate(
      'https://spec.openapis.org/oas/3.1/schema-base',
      spec as unknown as Json
    )
    const errors = !output.valid
      ? (output.errors
          ?.map((e) => `${e.instanceLocation}: ${e.absoluteKeywordLocation}`)
          .join('\n') ?? '')
      : ''
    expect(output.valid, errors).toBe(true)
  })

  it('has typed SourceConfig and DestinationConfig', async () => {
    const spec = await getSpec()
    const schemas = spec.components.schemas
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'StripeSourceConfig',
        'PostgresDestinationConfig',
        'GoogleSheetsDestinationConfig',
        'SourceConfig',
        'DestinationConfig',
        'PipelineConfig',
      ])
    )
  })

  it('has no $schema in component schemas', async () => {
    const spec = await getSpec()
    for (const [name, schema] of Object.entries<Record<string, unknown>>(spec.components.schemas)) {
      expect(schema, `${name} should not have $schema`).not.toHaveProperty('$schema')
    }
  })
})
