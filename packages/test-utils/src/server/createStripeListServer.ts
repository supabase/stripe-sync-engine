import { Hono } from 'hono'
import type { Context } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import pg from 'pg'
import {
  DEFAULT_STORAGE_SCHEMA,
  ensureSchema,
  quoteIdentifier,
  redactConnectionString,
} from '../db/storage.js'
import { resolveEndpointSet, type EndpointDefinition } from '../openapi/endpoints.js'
import { validateQueryAgainstOpenApi } from '../openapi/filters.js'
import { startDockerPostgres18, type DockerPostgres18Handle } from '../postgres/dockerPostgres18.js'
import type {
  StripeListServerOptions,
  StripeListServer,
  StripeListServerAuthOptions,
  StripeListServerFailureRule,
  PageResult,
  V1PageQuery,
  V2PageQuery,
} from './types.js'
export type { StripeListServerOptions, StripeListServer } from './types.js'

// ── Helpers ───────────────────────────────────────────────────────

const V2_PAGE_CURSOR_QUERY_PARAM = 'page'

// Hardcoded for testing purposes. don't want to reply on open api spec parser for testing known deprecation.
const REMOVED_ENDPOINTS = ['/v1/exchange_rates']

function makeFakeAccount(created: number) {
  return {
    id: 'acct_test_fake_000000',
    object: 'account',
    type: 'standard',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    business_type: 'company',
    country: 'US',
    default_currency: 'usd',
    email: 'test@example.com',
    created,
    settings: { dashboard: { display_name: 'Test Account' } },
  }
}

// ── Server factory ────────────────────────────────────────────────

export async function createStripeListServer(
  options: StripeListServerOptions = {}
): Promise<StripeListServer> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const schema = options.schema ?? DEFAULT_STORAGE_SCHEMA
  const endpointSet = await resolveEndpointSet({
    apiVersion: options.apiVersion,
    openApiSpecPath: options.openApiSpecPath,
    fetchImpl,
  })

  let dockerHandle: DockerPostgres18Handle | undefined
  let postgresMode: 'docker' | 'external' = 'external'
  const postgresUrl = options.postgresUrl ?? process.env.POSTGRES_URL
  if (!postgresUrl) {
    dockerHandle = await startDockerPostgres18()
    postgresMode = 'docker'
  }
  const connectionString = postgresUrl ?? dockerHandle?.connectionString
  if (!connectionString) {
    throw new Error('No Postgres connection string available')
  }

  const pool = new pg.Pool({ connectionString })
  await ensureSchema(pool, schema)

  const fakeAccount = makeFakeAccount(options.accountCreated ?? Math.floor(Date.now() / 1000))
  const failureStates = (options.failures ?? []).map(() => ({ matches: 0, failures: 0 }))
  const logRequests = options.logRequests ?? true

  // ── Build Hono app ────────────────────────────────────────────

  const app = new Hono()

  const perPath = new Map<string, { count: number; totalMs: number; maxMs: number }>()

  app.use('*', async (c, next) => {
    const start = performance.now()
    await next()
    const elapsed = performance.now() - start
    const stats = perPath.get(c.req.path)
    if (stats) {
      stats.count++
      stats.totalMs += elapsed
      if (elapsed > stats.maxMs) stats.maxMs = elapsed
    } else {
      perPath.set(c.req.path, { count: 1, totalMs: elapsed, maxMs: elapsed })
    }
    if (logRequests) {
      logRequest(c.req.method, c.req.path, c.res.status)
    }
  })

  for (const prefix of ['/v1/*', '/v2/*'] as const) {
    app.use(prefix, async (c, next) => {
      const intercepted = maybeInterceptStripeApiRequest(
        c,
        options.auth,
        options.failures ?? [],
        failureStates
      )
      if (intercepted) return intercepted
      await next()
    })
  }

  app.get('/health', (c) =>
    c.json({
      ok: true,
      api_version: endpointSet.apiVersion,
      endpoint_count: endpointSet.endpoints.size,
    })
  )

  app.get('/db-health', async (c) => {
    const probe = await pool.query('SELECT 1 AS ok')
    return c.json({
      ok: probe.rows[0]?.ok === 1,
      postgres_mode: postgresMode,
      postgres_url: redactConnectionString(connectionString),
      schema,
    })
  })

  app.get('/v1/account', (c) => c.json(fakeAccount))

  for (const path of REMOVED_ENDPOINTS) {
    app.all(path, (c) =>
      c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: `Unrecognized request URL (${c.req.method}: ${path}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
          },
        },
        404
      )
    )
  }

  for (const ep of endpointSet.endpoints.values()) {
    app.get(ep.apiPath, (c) =>
      handleList(c, pool, schema, ep, options.validateQueryParams ?? false)
    )
    app.get(`${ep.apiPath}/:id`, (c) => handleRetrieve(c, pool, schema, ep, c.req.param('id')))
  }

  for (const prefix of ['/v1/*', '/v2/*'] as const) {
    app.all(prefix, (c) => {
      if (c.req.method !== 'GET') {
        return c.json(
          { error: { type: 'invalid_request_error', message: 'Method not allowed' } },
          405
        )
      }
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: `Unrecognized request URL (GET: ${c.req.path})`,
          },
        },
        404
      )
    })
  }

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  })

  // ── Start server ──────────────────────────────────────────────

  const serverHost = options.host ?? '127.0.0.1'
  const serverPort = options.port ?? 5555

  let nodeServer: ServerType | undefined
  await new Promise<void>((resolve, reject) => {
    try {
      nodeServer = serve({ fetch: app.fetch, port: serverPort, hostname: serverHost }, () =>
        resolve()
      )
    } catch (err) {
      reject(err)
    }
  })

  const addr = nodeServer!.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : serverPort

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (perPath.size > 0) {
      const totalReqs = [...perPath.values()].reduce((a, b) => a + b.count, 0)
      const totalMs = [...perPath.values()].reduce((a, b) => a + b.totalMs, 0)
      const sorted = [...perPath.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)
      process.stderr.write(
        `[test-server] ${totalReqs} reqs across ${perPath.size} endpoints, total_time=${(totalMs / 1000).toFixed(1)}s\n`
      )
      for (const [p, s] of sorted) {
        const avg = (s.totalMs / s.count).toFixed(1)
        const total = (s.totalMs / 1000).toFixed(1)
        process.stderr.write(
          `  ${total.padStart(6)}s total ${s.count.toString().padStart(5)} reqs ${avg.padStart(6)}ms avg ${s.maxMs.toFixed(0).padStart(5)}ms max  ${p}\n`
        )
      }
    }
    if (nodeServer) {
      await new Promise<void>((resolve) => {
        nodeServer!.close(() => resolve())
      })
    }
    await pool.end().catch(() => undefined)
    if (dockerHandle) await dockerHandle.stop()
  }

  const cleanup = () => {
    void close()
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  return {
    host: serverHost,
    port: actualPort,
    url: `http://${serverHost}:${actualPort}`,
    postgresUrl: connectionString,
    postgresMode,
    close,
  }
}

// ---------------------------------------------------------------------------
// List — paginated read from Postgres, returns Stripe list response format
// ---------------------------------------------------------------------------

async function handleList(
  c: Context,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition,
  validateQueryParams: boolean
): Promise<Response> {
  const query = new URL(c.req.url).searchParams
  if (validateQueryParams) {
    const validated = validateQueryAgainstOpenApi(
      stripInternalPaginationParams(query, endpoint),
      endpoint.queryParams
    )
    if (!validated.ok) {
      process.stderr.write(
        `[sync-test-utils] query validation failed for ${endpoint.apiPath}: ` +
          `query="${query.toString()}" details=${JSON.stringify(validated.details)} ` +
          `allowed=${JSON.stringify(validated.allowed)}\n`
      )
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: validated.message,
            details: validated.details,
            allowed: validated.allowed,
          },
        },
        validated.statusCode as 400
      )
    }
  }

  if (endpoint.isV2) {
    const limit = clampLimit(query.get('limit') ?? undefined, 20)
    const pageToken = query.get(V2_PAGE_CURSOR_QUERY_PARAM) ?? undefined
    const afterId = pageToken ? decodePageToken(pageToken) : undefined

    const { data, hasMore, lastId } = await queryPageV2(pool, schema, endpoint.tableName, {
      limit,
      afterId,
      createdGt: parseTimestampParam(query.get('created[gt]') ?? undefined),
      createdGte: parseTimestampParam(query.get('created[gte]') ?? undefined),
      createdLt: parseTimestampParam(query.get('created[lt]') ?? undefined),
      createdLte: parseTimestampParam(query.get('created[lte]') ?? undefined),
    })

    const nextPageUrl =
      hasMore && lastId
        ? buildV2NextPageUrl(
            endpoint.apiPath,
            limit,
            encodePageToken(lastId),
            new URL(c.req.url).searchParams
          )
        : null

    return c.json({
      data,
      next_page_url: nextPageUrl,
      previous_page_url: null,
    })
  }

  const limit = clampLimit(query.get('limit') ?? undefined, 10)
  const v1Query = {
    limit,
    afterId: query.get('starting_after') ?? undefined,
    beforeId: query.get('ending_before') ?? undefined,
    createdGt: parseIntParam(query.get('created[gt]') ?? undefined),
    createdGte: parseIntParam(query.get('created[gte]') ?? undefined),
    createdLt: parseIntParam(query.get('created[lt]') ?? undefined),
    createdLte: parseIntParam(query.get('created[lte]') ?? undefined),
  }
  const supportsForwardPagination = endpoint.queryParams.some(
    (param) => param.name === 'starting_after'
  )
  const { data, hasMore } = supportsForwardPagination
    ? await queryPageV1(pool, schema, endpoint.tableName, v1Query)
    : await queryAllV1(pool, schema, endpoint.tableName, v1Query)

  return c.json({
    object: 'list',
    url: endpoint.apiPath,
    has_more: hasMore,
    data,
  })
}

// ---------------------------------------------------------------------------
// Retrieve — single object by ID from Postgres
// ---------------------------------------------------------------------------

async function handleRetrieve(
  c: Context,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition,
  objectId: string
): Promise<Response> {
  let rows: { _raw_data: Record<string, unknown> }[]
  try {
    const result = await pool.query(
      `SELECT _raw_data FROM ${quoteIdentifier(schema)}.${quoteIdentifier(endpoint.tableName)} WHERE id = $1 LIMIT 1`,
      [objectId]
    )
    rows = result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') {
      rows = []
    } else {
      throw err
    }
  }

  if (rows.length === 0) {
    return c.json(
      {
        error: {
          type: 'invalid_request_error',
          message: `No such ${endpoint.resourceId}: '${objectId}'`,
          param: 'id',
          code: 'resource_missing',
        },
      },
      404
    )
  }

  return c.json(rows[0]._raw_data as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Postgres queries — paginated reads from seeded tables
// ---------------------------------------------------------------------------

/**
 * V1: created DESC, id DESC; tuple cursors for starting_after / ending_before.
 * Cursor lookups are inlined as subqueries to avoid extra round trips.
 */
async function queryPageV1(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V1PageQuery
): Promise<PageResult> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0
  const useEndingBefore = !opts.afterId && !!opts.beforeId
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`

  if (opts.afterId) {
    conditions.push(
      `(created, id) < ((SELECT created FROM ${table} WHERE id = $${++idx}), $${idx})`
    )
    values.push(opts.afterId)
  }
  if (opts.beforeId) {
    conditions.push(
      `(created, id) > ((SELECT created FROM ${table} WHERE id = $${++idx}), $${idx})`
    )
    values.push(opts.beforeId)
  }
  if (opts.createdGt != null) {
    conditions.push(`created > $${++idx}`)
    values.push(opts.createdGt)
  }
  if (opts.createdGte != null) {
    conditions.push(`created >= $${++idx}`)
    values.push(opts.createdGte)
  }
  if (opts.createdLt != null) {
    conditions.push(`created < $${++idx}`)
    values.push(opts.createdLt)
  }
  if (opts.createdLte != null) {
    conditions.push(`created <= $${++idx}`)
    values.push(opts.createdLte)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const orderDir = useEndingBefore ? 'ASC' : 'DESC'
  const orderClause = `ORDER BY created ${orderDir}, id ${orderDir}`

  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${table} ${where} ${orderClause} LIMIT $${++idx}`,
    values,
    tableName
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  if (useEndingBefore) page.reverse()

  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

async function queryAllV1(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: Omit<V1PageQuery, 'limit' | 'afterId' | 'beforeId'>
): Promise<{ data: Record<string, unknown>[]; hasMore: false }> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0

  if (opts.createdGt != null) {
    conditions.push(`created > $${++idx}`)
    values.push(opts.createdGt)
  }
  if (opts.createdGte != null) {
    conditions.push(`created >= $${++idx}`)
    values.push(opts.createdGte)
  }
  if (opts.createdLt != null) {
    conditions.push(`created < $${++idx}`)
    values.push(opts.createdLt)
  }
  if (opts.createdLte != null) {
    conditions.push(`created <= $${++idx}`)
    values.push(opts.createdLte)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`
  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${table} ${where} ORDER BY created DESC, id DESC`,
    values,
    tableName
  )

  return { data: rows.map((row) => row._raw_data), hasMore: false }
}

/**
 * V2: opaque page tokens map to id ASC + `id > cursor`.
 * When the endpoint supports `created`, we apply the created window too.
 */
async function queryPageV2(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V2PageQuery
): Promise<PageResult> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0

  if (opts.afterId) {
    conditions.push(`id > $${++idx}`)
    values.push(opts.afterId)
  }
  if (opts.createdGt != null) {
    conditions.push(`created > $${++idx}`)
    values.push(opts.createdGt)
  }
  if (opts.createdGte != null) {
    conditions.push(`created >= $${++idx}`)
    values.push(opts.createdGte)
  }
  if (opts.createdLt != null) {
    conditions.push(`created < $${++idx}`)
    values.push(opts.createdLt)
  }
  if (opts.createdLte != null) {
    conditions.push(`created <= $${++idx}`)
    values.push(opts.createdLte)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const table = `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`
  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${table} ${where} ORDER BY id ASC LIMIT $${++idx}`,
    values,
    tableName
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

async function safeQuery(
  pool: pg.Pool,
  sql: string,
  values: unknown[],
  tableName: string
): Promise<{ _raw_data: Record<string, unknown> }[]> {
  try {
    const result = await pool.query(sql, values)
    return result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') {
      process.stderr.write(
        `[sync-test-utils] WARNING: table "${tableName}" does not exist — returning empty result. Was the database seeded?\n`
      )
      return []
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clampLimit(raw: string | undefined, defaultLimit: number): number {
  if (raw == null) return defaultLimit
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return defaultLimit
  return Math.min(n, 100)
}

function parseIntParam(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function parseTimestampParam(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
}

function encodePageToken(id: string): string {
  return Buffer.from(id).toString('base64url')
}

function decodePageToken(token: string): string {
  return Buffer.from(token, 'base64url').toString()
}

function stripInternalPaginationParams(
  query: URLSearchParams,
  endpoint: EndpointDefinition
): URLSearchParams {
  const normalized = new URLSearchParams(query)
  if (endpoint.isV2) {
    normalized.delete(V2_PAGE_CURSOR_QUERY_PARAM)
  }
  return normalized
}

/** Carry forward incoming filters on v2 next_page_url. */
function buildV2NextPageUrl(
  apiPath: string,
  limit: number,
  pageToken: string,
  incoming: URLSearchParams
): string {
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set(V2_PAGE_CURSOR_QUERY_PARAM, pageToken)
  for (const [key, value] of incoming.entries()) {
    if (key === 'limit' || key === V2_PAGE_CURSOR_QUERY_PARAM) continue
    qs.append(key, value)
  }
  return `${apiPath}?${qs.toString()}`
}

function logRequest(method: string, path: string, statusCode: number): void {
  process.stderr.write(`[sync-test-utils] ${method} ${path} → ${statusCode}\n`)
}

function maybeInterceptStripeApiRequest(
  c: Context,
  auth: StripeListServerAuthOptions | undefined,
  failures: StripeListServerFailureRule[],
  failureStates: Array<{ matches: number; failures: number }>
): Response | undefined {
  const authFailure = maybeHandleAuthFailure(c, auth)
  if (authFailure) return authFailure

  return maybeHandleInjectedFailure(c, failures, failureStates)
}

function maybeHandleAuthFailure(
  c: Context,
  auth: StripeListServerAuthOptions | undefined
): Response | undefined {
  if (!auth) return undefined
  const protectedPaths = auth.protectedPaths ?? ['/v1/*', '/v2/*']
  if (!pathMatchesAny(c.req.path, protectedPaths)) return undefined

  const bearerToken = extractBearerToken(c.req.header('authorization'))
  if (bearerToken === auth.expectedBearerToken) return undefined

  return c.json(
    {
      error: {
        type: 'invalid_request_error',
        message:
          auth.errorMessage ??
          (bearerToken ? `Invalid API Key provided: ${bearerToken}` : 'Invalid API Key provided'),
      },
    },
    401
  )
}

function maybeHandleInjectedFailure(
  c: Context,
  failures: StripeListServerFailureRule[],
  failureStates: Array<{ matches: number; failures: number }>
): Response | undefined {
  for (const [index, rule] of failures.entries()) {
    if (!matchesFailureRule(c.req.method, c.req.path, rule)) continue

    const state = failureStates[index]!
    state.matches += 1

    const after = rule.after ?? 0
    const times = rule.times ?? Number.POSITIVE_INFINITY
    if (state.matches <= after || state.failures >= times) continue

    state.failures += 1
    return new Response(JSON.stringify(buildFailureBody(rule, c.req.method, c.req.path)), {
      status: rule.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return undefined
}

function matchesFailureRule(
  method: string,
  path: string,
  rule: StripeListServerFailureRule
): boolean {
  const expectedMethod = (rule.method ?? 'GET').toUpperCase()
  if (method.toUpperCase() !== expectedMethod) return false
  return matchesPathPattern(path, rule.path)
}

function buildFailureBody(
  rule: StripeListServerFailureRule,
  method: string,
  path: string
): Record<string, unknown> {
  if (rule.body) return rule.body
  if (rule.stripeError) {
    return {
      error: {
        type: rule.stripeError.type ?? 'api_error',
        message: rule.stripeError.message,
        ...(rule.stripeError.code ? { code: rule.stripeError.code } : {}),
      },
    }
  }
  return {
    error: {
      type: 'api_error',
      message: `Injected failure for ${method.toUpperCase()} ${path}`,
    },
  }
}

function pathMatchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathPattern(path, pattern))
}

function matchesPathPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1))
  }
  return path === pattern
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1] ?? null
}
