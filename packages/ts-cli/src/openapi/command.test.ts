import { describe, expect, it, vi } from 'vitest'
import { buildCommand, createCliFromSpec } from './command.js'
import type { ParsedOperation } from './parse.js'
import type { OpenAPISpec } from './types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const syncSpec: OpenAPISpec = {
  paths: {
    '/syncs': {
      get: {
        operationId: 'listSyncs',
        tags: ['syncs'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'array' } } },
          },
        },
      },
      post: {
        operationId: 'createSync',
        tags: ['syncs'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Sync name' },
                  source: { type: 'object' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/syncs/{id}': {
      get: {
        operationId: 'getSync',
        tags: ['syncs'],
        parameters: [{ name: 'id', in: 'path', required: true }],
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
          { name: 'x-source-config', in: 'header', required: true },
          { name: 'x-destination-config', in: 'header', required: false },
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
// buildCommand
// ---------------------------------------------------------------------------

describe('buildCommand', () => {
  it('creates a command with the operation name', () => {
    const op: ParsedOperation = {
      method: 'get',
      path: '/syncs',
      operationId: 'listSyncs',
      tags: ['syncs'],
      pathParams: [],
      queryParams: [{ name: 'limit', in: 'query' }],
      headerParams: [],
      ndjsonResponse: false,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    expect(cmd.name()).toBe('list-syncs')
  })

  it('creates positional argument for path param', () => {
    const op: ParsedOperation = {
      method: 'get',
      path: '/syncs/{id}',
      operationId: 'getSync',
      tags: [],
      pathParams: [{ name: 'id', in: 'path', required: true }],
      queryParams: [],
      headerParams: [],
      ndjsonResponse: false,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    const argNames = cmd.registeredArguments.map((a) => a.name())
    expect(argNames).toContain('id')
  })

  it('creates --flag options for query params', () => {
    const op: ParsedOperation = {
      method: 'get',
      path: '/syncs',
      operationId: 'listSyncs',
      tags: [],
      pathParams: [],
      queryParams: [
        { name: 'limit', in: 'query' },
        { name: 'cursor', in: 'query' },
      ],
      headerParams: [],
      ndjsonResponse: false,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    const optNames = cmd.options.map((o) => o.long)
    expect(optNames).toContain('--limit')
    expect(optNames).toContain('--cursor')
  })

  it('creates --flags for header params (kebab-cased)', () => {
    const op: ParsedOperation = {
      method: 'post',
      path: '/syncs/{id}/run',
      operationId: 'runSync',
      tags: [],
      pathParams: [{ name: 'id', in: 'path', required: true }],
      queryParams: [],
      headerParams: [{ name: 'x-source-config', in: 'header', required: true }],
      ndjsonResponse: true,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    const optNames = cmd.options.map((o) => o.long)
    expect(optNames).toContain('--x-source-config')
  })

  it('creates per-property --flags for flat body schema', () => {
    const op: ParsedOperation = {
      method: 'post',
      path: '/syncs',
      operationId: 'createSync',
      tags: [],
      pathParams: [],
      queryParams: [],
      headerParams: [],
      bodySchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          source: { type: 'object' },
        },
        required: ['name'],
      },
      bodyRequired: true,
      ndjsonResponse: false,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    const optNames = cmd.options.map((o) => o.long)
    expect(optNames).toContain('--name')
    expect(optNames).toContain('--source')
  })

  it('creates --body for complex/nested body', () => {
    const op: ParsedOperation = {
      method: 'post',
      path: '/syncs',
      operationId: 'createSync',
      tags: [],
      pathParams: [],
      queryParams: [],
      headerParams: [],
      bodySchema: { type: 'object' }, // no properties → complex
      bodyRequired: false,
      ndjsonResponse: false,
      ndjsonRequest: false,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    const optNames = cmd.options.map((o) => o.long)
    expect(optNames).toContain('--body')
  })
})

// ---------------------------------------------------------------------------
// createCliFromSpec — integration test
// ---------------------------------------------------------------------------

describe('createCliFromSpec', () => {
  it('creates a root command with subcommands for all operations', () => {
    const handler = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        headers: { 'content-type': 'application/json' },
      })
    )
    const root = createCliFromSpec({ spec: syncSpec, handler })
    const names = root.commands.map((c) => c.name())
    expect(names).toContain('list-syncs')
    expect(names).toContain('create-sync')
    expect(names).toContain('get-sync')
    expect(names).toContain('delete-sync')
    expect(names).toContain('run-sync')
  })

  it('excludes operations by operationId', () => {
    const handler = vi.fn()
    const root = createCliFromSpec({
      spec: syncSpec,
      handler,
      exclude: ['deleteSync', 'runSync'],
    })
    const names = root.commands.map((c) => c.name())
    expect(names).not.toContain('delete-sync')
    expect(names).not.toContain('run-sync')
    expect(names).toContain('list-syncs')
  })

  it('groups commands by tag when groupByTag=true', () => {
    const handler = vi.fn()
    const root = createCliFromSpec({ spec: syncSpec, handler, groupByTag: true })
    // All ops have tag 'syncs', so there's a 'syncs' subcommand group
    const groupNames = root.commands.map((c) => c.name())
    expect(groupNames).toContain('syncs')
    const syncsGroup = root.commands.find((c) => c.name() === 'syncs')!
    const cmdNames = syncsGroup.commands.map((c) => c.name())
    expect(cmdNames).toContain('list-syncs')
    expect(cmdNames).toContain('run-sync')
  })

  it('calls handler with correctly constructed Request', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(
        new Response(JSON.stringify([{ id: 'sync_1' }]), {
          headers: { 'content-type': 'application/json' },
        })
      )
    })

    // Mock stdout so the command doesn't write during tests
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const root = createCliFromSpec({ spec: syncSpec, handler })
    await root.parseAsync(['list-syncs', '--limit', '5'], { from: 'user' })

    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!
    expect(req.method).toBe('GET')
    const url = new URL(req.url)
    expect(url.pathname).toBe('/syncs')
    expect(url.searchParams.get('limit')).toBe('5')

    writeSpy.mockRestore()
  })

  it('dispatches getSync with path param', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'sync_abc' }), {
          headers: { 'content-type': 'application/json' },
        })
      )
    })

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const root = createCliFromSpec({ spec: syncSpec, handler })
    await root.parseAsync(['get-sync', 'sync_abc'], { from: 'user' })

    expect(capturedRequests[0]!.url).toContain('/syncs/sync_abc')

    writeSpy.mockRestore()
  })

  it('uses custom nameOperation when provided', () => {
    const handler = vi.fn()
    const root = createCliFromSpec({
      spec: syncSpec,
      handler,
      nameOperation: (method, path) => `${method.toUpperCase()}:${path}`,
    })
    const names = root.commands.map((c) => c.name())
    expect(names).toContain('GET:/syncs')
  })
})
