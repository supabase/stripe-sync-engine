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

  it('has SyncState as a named component schema', async () => {
    const spec = await getSpec()
    expect(spec.components.schemas).toHaveProperty('SyncState')
    const syncState = spec.components.schemas['SyncState'] as Record<string, unknown>
    expect(syncState.type).toBe('object')
    expect(syncState).toHaveProperty('properties')
    const props = syncState.properties as Record<string, unknown>
    expect(props).toHaveProperty('source')
    expect(props).toHaveProperty('destination')
    expect(props).toHaveProperty('sync_run')
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

  it('sync routes accept JSON body with state field referencing SyncState', async () => {
    const spec = await getSpec()
    for (const path of ['/pipeline_read', '/pipeline_sync']) {
      const op = (spec.paths as Record<string, any>)[path]?.post
      expect(op, `${path} should exist`).toBeDefined()
      const bodySchema = op.requestBody?.content?.['application/json']?.schema
      expect(bodySchema, `${path} should have JSON body schema`).toBeDefined()
      // state field should $ref SyncState
      const stateField = bodySchema?.properties?.state
      expect(stateField, `${path} state should reference SyncState`).toMatchObject({
        $ref: '#/components/schemas/SyncState',
      })
    }
    // SyncState should still be a named component
    expect(spec.components.schemas).toHaveProperty('SyncState')
  })
})
