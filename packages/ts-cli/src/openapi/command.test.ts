import { describe, expect, it, vi } from 'vitest'
import { runCommand } from 'citty'
import type { CommandDef } from 'citty'
import { buildCommand, createCliFromSpec, toCliFlag } from './command.js'
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
// Helpers for introspecting citty CommandDef
// ---------------------------------------------------------------------------

function cmdName(cmd: CommandDef): string | undefined {
  return cmd.meta?.name
}

function positionalNames(cmd: CommandDef): string[] {
  return Object.entries(cmd.args ?? {})
    .filter(([, def]) => def.type === 'positional')
    .map(([key]) => key)
}

function optionFlags(cmd: CommandDef): string[] {
  return Object.entries(cmd.args ?? {})
    .filter(([, def]) => def.type !== 'positional')
    .map(([key]) => '--' + toCliFlag(key))
}

function subCommandNames(cmd: CommandDef): string[] {
  return Object.keys(cmd.subCommands ?? {})
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
    expect(cmdName(cmd)).toBe('list-syncs')
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
    expect(positionalNames(cmd)).toContain('id')
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
    const flags = optionFlags(cmd)
    expect(flags).toContain('--limit')
    expect(flags).toContain('--cursor')
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
    expect(optionFlags(cmd)).toContain('--x-source-config')
  })

  it('creates --body for NDJSON body schema', () => {
    const op: ParsedOperation = {
      method: 'post',
      path: '/write',
      operationId: 'write',
      tags: [],
      pathParams: [],
      queryParams: [],
      headerParams: [],
      bodySchema: { type: 'string' },
      bodyRequired: true,
      ndjsonResponse: false,
      ndjsonRequest: true,
      noContent: false,
    }
    const handler = vi.fn()
    const cmd = buildCommand(op, handler)
    expect(optionFlags(cmd)).toContain('--body')
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
    const names = subCommandNames(root)
    expect(names).toContain('list-syncs')
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
    const names = subCommandNames(root)
    expect(names).not.toContain('delete-sync')
    expect(names).not.toContain('run-sync')
    expect(names).toContain('list-syncs')
  })

  it('groups commands by tag when groupByTag=true', () => {
    const handler = vi.fn()
    const root = createCliFromSpec({ spec: syncSpec, handler, groupByTag: true })
    // All ops have tag 'syncs', so there's a 'syncs' subcommand group
    const groupNames = subCommandNames(root)
    expect(groupNames).toContain('syncs')
    const syncsGroup = root.subCommands!['syncs'] as CommandDef
    const cmdNames = subCommandNames(syncsGroup)
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
    await runCommand(root, { rawArgs: ['list-syncs', '--limit', '5'] })

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
    await runCommand(root, { rawArgs: ['get-sync', 'sync_abc'] })

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
    const names = subCommandNames(root)
    expect(names).toContain('GET:/syncs')
  })
})

// ---------------------------------------------------------------------------
// ndjsonBodyStream
// ---------------------------------------------------------------------------

const ndjsonWriteSpec: OpenAPISpec = {
  paths: {
    '/write': {
      post: {
        operationId: 'write',
        tags: [],
        requestBody: {
          required: true,
          content: { 'application/x-ndjson': { schema: { type: 'string' } } },
        },
        responses: {
          '200': { description: 'OK', content: { 'application/x-ndjson': {} } },
        },
      },
    },
  },
}

describe('ndjsonBodyStream', () => {
  it('uses ReadableStream as body and sets Content-Type + Transfer-Encoding headers', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(
        new Response('{"type":"state","stream":"s","data":{}}\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      )
    })

    const ndjsonLine =
      '{"type":"record","stream":"test","data":{"id":"1"},"emitted_at":"2024-01-01T00:00:00.000Z"}'
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(ndjsonLine + '\n'))
        controller.close()
      },
    })

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const root = createCliFromSpec({
      spec: ndjsonWriteSpec,
      handler,
      ndjsonBodyStream: () => stream as ReadableStream,
    })

    // bodyRequired=true but --body is optional when ndjsonBodyStream is provided
    await runCommand(root, { rawArgs: ['write'] })

    writeSpy.mockRestore()

    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!
    expect(req.method).toBe('POST')
    expect(req.headers.get('Content-Type')).toBe('application/x-ndjson')
    expect(req.headers.get('Transfer-Encoding')).toBe('chunked')
    expect(req.body).not.toBeNull()
    const bodyText = await req.text()
    expect(bodyText).toContain('"type":"record"')
  })

  it('falls back to --body flag when ndjsonBodyStream returns null', async () => {
    const capturedRequests: Request[] = []
    const handler = vi.fn().mockImplementation((req: Request) => {
      capturedRequests.push(req)
      return Promise.resolve(new Response('', { status: 200 }))
    })

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const root = createCliFromSpec({
      spec: ndjsonWriteSpec,
      handler,
      ndjsonBodyStream: () => null, // TTY — no stdin
    })

    await runCommand(root, { rawArgs: ['write', '--body', 'line1\nline2'] })

    writeSpy.mockRestore()

    expect(capturedRequests).toHaveLength(1)
    const req = capturedRequests[0]!
    // No stream override — Transfer-Encoding is NOT set
    expect(req.headers.get('Transfer-Encoding')).toBeNull()
    // --body value is used as body
    const bodyText = await req.text()
    expect(bodyText).toBe('line1\nline2')
  })

  it('makes --body optional for ndjson operations when ndjsonBodyStream is provided', () => {
    const handler = vi.fn()
    const root = createCliFromSpec({
      spec: ndjsonWriteSpec,
      handler,
      ndjsonBodyStream: () => new ReadableStream(),
    })
    const writeCmd = root.subCommands!['write'] as CommandDef
    // Should be optional (not required), since stream provides the body
    expect(writeCmd.args?.['body']?.required).toBe(false)
  })
})
