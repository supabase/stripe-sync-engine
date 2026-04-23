import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRequest, handleResponse, toOptName } from './dispatch.js'
import type { ParsedOperation } from './parse.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseOperation: ParsedOperation = {
  method: 'get',
  path: '/syncs',
  operationId: 'listSyncs',
  tags: ['syncs'],
  pathParams: [],
  queryParams: [],
  headerParams: [],
  bodySchema: undefined,
  bodyRequired: false,
  ndjsonResponse: false,
  ndjsonRequest: false,
  noContent: false,
}

// ---------------------------------------------------------------------------
// buildRequest
// ---------------------------------------------------------------------------

describe('buildRequest', () => {
  it('builds a simple GET request', () => {
    const req = buildRequest(baseOperation, [], {})
    expect(req.method).toBe('GET')
    expect(req.url).toBe('http://localhost/syncs')
  })

  it('substitutes path params into URL', () => {
    const op: ParsedOperation = {
      ...baseOperation,
      method: 'get',
      path: '/syncs/{id}',
      pathParams: [{ name: 'id', in: 'path', required: true }],
    }
    const req = buildRequest(op, ['sync_abc'], {})
    expect(req.url).toBe('http://localhost/syncs/sync_abc')
  })

  it('percent-encodes path params', () => {
    const op: ParsedOperation = {
      ...baseOperation,
      path: '/syncs/{id}',
      pathParams: [{ name: 'id', in: 'path', required: true }],
    }
    const req = buildRequest(op, ['hello world'], {})
    expect(req.url).toContain('hello%20world')
  })

  it('appends query params to URL', () => {
    const op: ParsedOperation = {
      ...baseOperation,
      queryParams: [
        { name: 'limit', in: 'query' },
        { name: 'cursor', in: 'query' },
      ],
    }
    const req = buildRequest(op, [], { limit: '10', cursor: 'tok_abc' })
    const url = new URL(req.url)
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('cursor')).toBe('tok_abc')
  })

  it('skips absent query params', () => {
    const op: ParsedOperation = {
      ...baseOperation,
      queryParams: [{ name: 'limit', in: 'query' }],
    }
    const req = buildRequest(op, [], {})
    const url = new URL(req.url)
    expect(url.searchParams.has('limit')).toBe(false)
  })

  it('sets header params', () => {
    const op: ParsedOperation = {
      ...baseOperation,
      headerParams: [{ name: 'x-api-key', in: 'header', required: true }],
    }
    const req = buildRequest(op, [], { xApiKey: 'sk_test_123' })
    expect(req.headers.get('x-api-key')).toBe('sk_test_123')
  })

  it('passes --body as NDJSON for body schema', async () => {
    const op: ParsedOperation = {
      ...baseOperation,
      method: 'post',
      path: '/write',
      bodySchema: { type: 'string' },
      ndjsonRequest: true,
    }
    const req = buildRequest(op, [], { body: '{"type":"record"}\n' })
    expect(req.headers.get('content-type')).toBe('application/x-ndjson')
    const text = await req.text()
    expect(text).toBe('{"type":"record"}\n')
  })

  it('uses provided baseUrl', () => {
    const req = buildRequest(baseOperation, [], {}, 'https://api.example.com')
    expect(req.url).toBe('https://api.example.com/syncs')
  })
})

// ---------------------------------------------------------------------------
// handleResponse
// ---------------------------------------------------------------------------

describe('handleResponse', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`process.exit(${_code})`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes JSON to stdout with 2-space indent', async () => {
    const response = new Response(JSON.stringify({ id: 'sync_1', name: 'test' }), {
      headers: { 'content-type': 'application/json' },
    })
    await handleResponse(response, baseOperation)
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ id: 'sync_1', name: 'test' }, null, 2) + '\n'
    )
  })

  it('streams NDJSON lines to stdout', async () => {
    const ndjsonOp: ParsedOperation = { ...baseOperation, ndjsonResponse: true }
    const lines = ['{"type":"data","record":{"id":1}}', '{"type":"state","cursor":"abc"}']
    const response = new Response(lines.join('\n') + '\n', {
      headers: { 'content-type': 'application/x-ndjson' },
    })
    await handleResponse(response, ndjsonOp)
    const written = stdoutSpy.mock.calls.map((c) => c[0] as string).join('')
    expect(written).toContain(lines[0])
    expect(written).toContain(lines[1])
  })

  it('writes nothing for 204', async () => {
    const op: ParsedOperation = { ...baseOperation, noContent: true }
    const response = new Response(null, { status: 204 })
    await handleResponse(response, op)
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('writes error to stderr and exits 1 on 4xx', async () => {
    const response = new Response('Not found', { status: 404 })
    await expect(handleResponse(response, baseOperation)).rejects.toThrow('process.exit(1)')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('404'))
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('writes error to stderr and exits 1 on 5xx', async () => {
    const response = new Response('Internal error', { status: 500 })
    await expect(handleResponse(response, baseOperation)).rejects.toThrow('process.exit(1)')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('500'))
  })
})

// ---------------------------------------------------------------------------
// toOptName
// ---------------------------------------------------------------------------

describe('toOptName', () => {
  it('passes through simple lowercase names', () => {
    expect(toOptName('limit')).toBe('limit')
  })

  it('converts snake_case to camelCase', () => {
    expect(toOptName('api_key')).toBe('apiKey')
  })

  it('converts kebab-case to camelCase', () => {
    expect(toOptName('x-api-key')).toBe('xApiKey')
  })

  it('converts mixed snake+camel', () => {
    expect(toOptName('my_field_name')).toBe('myFieldName')
  })
})
