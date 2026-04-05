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

  it('has typed Source and Destination schemas', async () => {
    const spec = await getSpec()
    const schemas = spec.components.schemas
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'SourceStripeConfig',
        'DestinationPostgresConfig',
        'DestinationGoogleSheetsConfig',
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

  it('has SourceState as a named component schema', async () => {
    const spec = await getSpec()
    expect(spec.components.schemas).toHaveProperty('SourceState')
    const sourceState = spec.components.schemas['SourceState'] as Record<string, unknown>
    expect(sourceState.type).toBe('object')
    expect(sourceState).toHaveProperty('properties')
    const props = sourceState.properties as Record<string, unknown>
    expect(props).toHaveProperty('streams')
    expect(props).toHaveProperty('global')
  })

  it('header params use application/json content key, never [object Object]', async () => {
    const spec = await getSpec()
    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(pathItem as Record<string, unknown>)) {
        const operation = op as { parameters?: Array<Record<string, unknown>> } | undefined
        for (const param of operation?.parameters ?? []) {
          const content = param.content as Record<string, unknown> | undefined
          if (content) {
            expect(
              Object.keys(content),
              `${method.toUpperCase()} ${path} param "${param.name}" has [object Object] content key`
            ).not.toContain('[object Object]')
          }
        }
      }
    }
  })

  it('x-source-state header uses application/json content with $ref to SourceState', async () => {
    const spec = await getSpec()
    const allParams: Array<Record<string, unknown>> = []
    for (const pathItem of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(pathItem as Record<string, unknown>)) {
        const operation = op as { parameters?: Array<Record<string, unknown>> } | undefined
        allParams.push(...(operation?.parameters ?? []))
      }
    }
    const stateParams = allParams.filter((p) => p.name === 'x-source-state')
    expect(stateParams.length).toBeGreaterThan(0)
    for (const param of stateParams) {
      expect(param.schema).toBeUndefined()
      const content = param.content as Record<string, Record<string, unknown>> | undefined
      expect(content?.['application/json']).toBeDefined()
      expect(content?.['application/json']?.schema).toMatchObject({
        $ref: '#/components/schemas/SourceState',
      })
    }
  })
})
