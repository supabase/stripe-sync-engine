import { describe, expect, it } from 'vitest'
import { defaultOperationName, isNdjsonResponse, parseSpec, toCliFlag } from './parse.js'
import type { OpenAPISpec } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const basicSpec: OpenAPISpec = {
  paths: {
    '/syncs': {
      get: {
        operationId: 'listSyncs',
        tags: ['syncs'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/syncs/{id}': {
      get: {
        operationId: 'getSync',
        tags: ['syncs'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK', content: { 'application/json': {} } },
        },
      },
      delete: {
        operationId: 'deleteSync',
        tags: ['syncs'],
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: { '204': { description: 'No Content' } },
      },
    },
    '/syncs/{id}/run': {
      post: {
        operationId: 'runSync',
        tags: ['syncs'],
        parameters: [
          { name: 'id', in: 'path', required: true },
          { name: 'x-api-key', in: 'header', required: true },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/x-ndjson': {} },
          },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// parseSpec
// ---------------------------------------------------------------------------

describe('parseSpec', () => {
  it('extracts all operations', () => {
    const ops = parseSpec(basicSpec)
    expect(ops).toHaveLength(4)
  })

  it('separates path/query/header params', () => {
    const ops = parseSpec(basicSpec)
    const runSync = ops.find((o) => o.operationId === 'runSync')!
    expect(runSync.pathParams).toHaveLength(1)
    expect(runSync.pathParams[0]!.name).toBe('id')
    expect(runSync.headerParams).toHaveLength(1)
    expect(runSync.headerParams[0]!.name).toBe('x-api-key')
    expect(runSync.queryParams).toHaveLength(0)
  })

  it('extracts body schema for NDJSON POST', () => {
    const spec: OpenAPISpec = {
      paths: {
        '/write': {
          post: {
            operationId: 'write',
            requestBody: {
              required: true,
              content: {
                'application/x-ndjson': {
                  schema: { type: 'string' },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    }

    const ops = parseSpec(spec)
    const write = ops.find((o) => o.operationId === 'write')!
    expect(write.bodySchema).toEqual({ type: 'string' })
    expect(write.bodyRequired).toBe(true)
    expect(write.ndjsonRequest).toBe(true)
  })

  it('extracts body schema for JSON-only request body', () => {
    const spec: OpenAPISpec = {
      paths: {
        '/create': {
          post: {
            operationId: 'createThing',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    }

    const ops = parseSpec(spec)
    const op = ops.find((o) => o.operationId === 'createThing')!
    expect(op.bodySchema).toEqual({ type: 'object', properties: { name: { type: 'string' } } })
    expect(op.ndjsonRequest).toBe(false)
  })

  it('detects NDJSON response', () => {
    const ops = parseSpec(basicSpec)
    const runSync = ops.find((o) => o.operationId === 'runSync')!
    expect(runSync.ndjsonResponse).toBe(true)
    const listSyncs = ops.find((o) => o.operationId === 'listSyncs')!
    expect(listSyncs.ndjsonResponse).toBe(false)
  })

  it('detects 204 noContent', () => {
    const ops = parseSpec(basicSpec)
    const deleteSync = ops.find((o) => o.operationId === 'deleteSync')!
    expect(deleteSync.noContent).toBe(true)
    const listSyncs = ops.find((o) => o.operationId === 'listSyncs')!
    expect(listSyncs.noContent).toBe(false)
  })

  it('tags are populated', () => {
    const ops = parseSpec(basicSpec)
    const listSyncs = ops.find((o) => o.operationId === 'listSyncs')!
    expect(listSyncs.tags).toEqual(['syncs'])
  })

  it('ignores non-method keys in pathItem', () => {
    const spec: OpenAPISpec = {
      paths: {
        '/test': {
          parameters: [] as never, // non-method key
          get: {
            operationId: 'getTest',
            responses: {},
          },
        },
      },
    }
    const ops = parseSpec(spec)
    expect(ops).toHaveLength(1)
    expect(ops[0]!.operationId).toBe('getTest')
  })
})

// ---------------------------------------------------------------------------
// toCliFlag
// ---------------------------------------------------------------------------

describe('toCliFlag', () => {
  it('lowercases plain names', () => {
    expect(toCliFlag('limit')).toBe('limit')
  })

  it('converts snake_case to kebab-case', () => {
    expect(toCliFlag('api_key')).toBe('api-key')
    expect(toCliFlag('x_api_key')).toBe('x-api-key')
  })

  it('converts camelCase to kebab-case', () => {
    expect(toCliFlag('listSyncs')).toBe('list-syncs')
    expect(toCliFlag('operationId')).toBe('operation-id')
  })

  it('converts mixed camel+snake to kebab-case', () => {
    expect(toCliFlag('myField_name')).toBe('my-field-name')
  })

  it('handles already-kebab names', () => {
    expect(toCliFlag('x-api-key')).toBe('x-api-key')
  })
})

// ---------------------------------------------------------------------------
// defaultOperationName
// ---------------------------------------------------------------------------

describe('defaultOperationName', () => {
  it('uses operationId when present (camelCase → kebab)', () => {
    expect(defaultOperationName('get', '/syncs', { operationId: 'listSyncs' })).toBe('list-syncs')
    expect(defaultOperationName('post', '/syncs', { operationId: 'createSync' })).toBe(
      'create-sync'
    )
  })

  it('derives from method+path when no operationId', () => {
    expect(defaultOperationName('get', '/syncs', {})).toBe('get-syncs')
    expect(defaultOperationName('post', '/syncs', {})).toBe('post-syncs')
  })

  it('strips path params from derived name', () => {
    expect(defaultOperationName('get', '/syncs/{id}', {})).toBe('get-syncs')
    expect(defaultOperationName('post', '/syncs/{id}/run', {})).toBe('post-syncs-run')
  })

  it('handles deeply nested paths', () => {
    expect(defaultOperationName('delete', '/org/{orgId}/syncs/{id}', {})).toBe('delete-org-syncs')
  })
})

// ---------------------------------------------------------------------------
// isNdjsonResponse
// ---------------------------------------------------------------------------

describe('isNdjsonResponse', () => {
  it('returns true when response has x-ndjson content', () => {
    expect(
      isNdjsonResponse({
        responses: {
          '200': { content: { 'application/x-ndjson': {} } },
        },
      })
    ).toBe(true)
  })

  it('returns false for JSON-only response', () => {
    expect(
      isNdjsonResponse({
        responses: {
          '200': { content: { 'application/json': {} } },
        },
      })
    ).toBe(false)
  })

  it('returns false when no responses', () => {
    expect(isNdjsonResponse({})).toBe(false)
  })
})
