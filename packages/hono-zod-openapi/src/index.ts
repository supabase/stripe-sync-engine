/**
 * @stripe/sync-hono-zod-openapi
 *
 * A Hono integration that uses `zod-openapi` (samchungy/zod-openapi) for OpenAPI 3.1
 * spec generation. Key improvements over @hono/zod-openapi:
 *
 * - z.literal() → `const` (not `enum`) — correct JSON Schema 2020-12
 * - z.discriminatedUnion() → `discriminator.mapping` auto-generated when variants have `.meta({ id })`
 * - Named $ref components via `.meta({ id })` on any Zod schema
 * - No prototype patching required
 *
 * API surface intentionally mirrors @hono/zod-openapi with adaptations for the
 * zod-openapi path/body format (`requestParams` / `requestBody` instead of `request`).
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { HTTPException } from 'hono/http-exception'
import { createDocument, createSchema } from 'zod-openapi'
import type { Hook } from '@hono/zod-validator'
import type {
  Context,
  Env,
  Handler,
  Input,
  MiddlewareHandler,
  Schema,
  ValidationTargets,
} from 'hono'
import type {
  ZodOpenApiOperationObject,
  ZodOpenApiObject,
  ZodOpenApiComponentsObject,
  ZodOpenApiPathsObject,
  CreateDocumentOptions,
} from 'zod-openapi'
import { z } from 'zod'
import type { ZodType, ZodError, input as ZodInput, output as ZodOutput } from 'zod'

// ── Types ────────────────────────────────────────────────────────

type Method = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options' | 'trace'

/**
 * Route config: ZodOpenApiOperationObject extended with Hono routing fields.
 *
 * Use `requestParams` for path/query/header/cookie params (keyed by OpenAPI location names):
 *   requestParams: { path: z.object({ id: z.string() }), query: ..., header: ..., cookie: ... }
 *
 * Use `requestBody` for the request body:
 *   requestBody: { content: { 'application/json': { schema: MySchema } }, required: true }
 *
 * Response keys must be strings: '200', '400', etc.
 *
 * Set `hide: true` to exclude the route from the generated spec (e.g. /internal/*).
 */
export interface RouteConfig extends ZodOpenApiOperationObject {
  method: Method
  path: string // OpenAPI path format: /items/{id}
  hide?: boolean
}

// Default hook type — passed to every zValidator call on the app.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DefaultHook = Hook<any, Env, string, keyof ValidationTargets, any>

// ── Path conversion ──────────────────────────────────────────────

/** Convert OpenAPI path format `{param}` to Hono format `:param`. */
function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1')
}

// ── TypeScript inference for handler input ───────────────────────
//
// Given a RouteConfig R, derive the Hono Input type so that
// c.req.valid('param'), c.req.valid('json'), etc. are typed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyZod = ZodType<any, any, any>

type ParamInput<R extends RouteConfig> = R['requestParams'] extends { path: infer P extends AnyZod }
  ? { in: { param: Record<string, string> }; out: { param: ZodOutput<P> } }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

type QueryInput<R extends RouteConfig> = R['requestParams'] extends {
  query: infer Q extends AnyZod
}
  ? { in: { query: Record<string, string | string[]> }; out: { query: ZodOutput<Q> } }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

type HeaderInput<R extends RouteConfig> = R['requestParams'] extends {
  header: infer H extends AnyZod
}
  ? { in: { header: Record<string, string> }; out: { header: ZodOutput<H> } }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

type CookieInput<R extends RouteConfig> = R['requestParams'] extends {
  cookie: infer C extends AnyZod
}
  ? { in: { cookie: Record<string, string> }; out: { cookie: ZodOutput<C> } }
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

type JsonBodyInput<R extends RouteConfig> = R['requestBody'] extends { content: infer C }
  ? 'application/json' extends keyof C
    ? C['application/json'] extends { schema: infer S extends AnyZod }
      ? { in: { json: ZodInput<S> }; out: { json: ZodOutput<S> } }
      : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        {}
    : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
      {}
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {}

type RouteInput<R extends RouteConfig> = ParamInput<R> &
  QueryInput<R> &
  HeaderInput<R> &
  CookieInput<R> &
  JsonBodyInput<R>

// Convert OpenAPI path format to Hono's string template type for proper path param inference.
type ConvertPath<P extends string> = P extends `${infer L}/{${infer K}}${infer R}`
  ? `${L}/:${K}${ConvertPath<R>}`
  : P

// ── JSON content header support ──────────────────────────────────
//
// Header fields annotated with .meta({ param: { content: 'application/json' } })
// on a z.string().transform(JSON.parse).pipe(schema) chain get:
//   - Runtime: zValidator parses JSON via transform, validates via pipe (no custom middleware)
//   - OAS spec: parameter uses `content: { 'application/json': { schema } }` with the pipe output type

/**
 * Walk a Zod schema to find the innermost pipe output.
 * Unwraps optional/nullable/pipe wrappers to reach the destination schema.
 */
function getPipeOutput(schema: AnyZod): AnyZod | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._zod?.def
  if (!def) return undefined
  if (def.type === 'pipe' && def.out) return def.out
  if ((def.type === 'optional' || def.type === 'nullable') && def.innerType) {
    return getPipeOutput(def.innerType)
  }
  return undefined
}

/**
 * Check if a header field schema has the JSON content meta annotation.
 * Returns the content media type string (e.g. 'application/json') or undefined.
 *
 * Accepts either object form `.meta({ param: { content: { 'application/json': {} } } })`
 * (the OAS-typed form, preferred) or legacy string form `.meta({ param: { content: 'application/json' } })`.
 */
function getParamContentType(schema: AnyZod): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = z.globalRegistry.get(schema as any) as Record<string, unknown> | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content = (meta?.param as any)?.content
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') return Object.keys(content)[0]
  // Unwrap optional/nullable to find meta on the inner schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._zod?.def
  if ((def?.type === 'optional' || def?.type === 'nullable') && def.innerType) {
    return getParamContentType(def.innerType)
  }
  return undefined
}

function isApplicationJsonContentType(contentType?: string): boolean {
  const mediaType = normalizeMediaType(contentType)
  return mediaType === 'application/json'
}

function normalizeMediaType(contentType?: string): string | undefined {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase()
}

function isJsonLikeContentType(contentType?: string): boolean {
  const mediaType = normalizeMediaType(contentType)
  return mediaType != null && /^application\/([a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType)
}

/**
 * For spec generation, separate header fields into plain (use schema) and
 * JSON content (use content encoding). Returns a modified op with JSON content
 * fields stripped from requestParams.header and added as raw ParameterObjects.
 *
 * Also collects the pipe output Zod schemas so they can be passed to
 * `createDocument` for full recursive component discovery.
 */
function processJsonContentHeaders(op: ZodOpenApiOperationObject): {
  specOp: ZodOpenApiOperationObject
  pipeOutputSchemas: AnyZod[]
} {
  const headerSchema = op.requestParams?.header
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (headerSchema as any)?._zod?.def?.shape as Record<string, AnyZod> | undefined
  if (!shape) return { specOp: op, pipeOutputSchemas: [] }

  const plainShape: Record<string, AnyZod> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonParams: any[] = []
  const pipeOutputSchemas: AnyZod[] = []
  let hasJsonFields = false

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const contentType = getParamContentType(fieldSchema)
    if (!contentType) {
      plainShape[key] = fieldSchema
      continue
    }

    hasJsonFields = true
    const pipeOut = getPipeOutput(fieldSchema)
    if (!pipeOut) {
      plainShape[key] = fieldSchema
      continue
    }

    // Use createSchema for the parameter's content schema (produces $ref if .meta({ id }) is set)
    const { schema: jsonSchema } = createSchema(pipeOut)
    // Collect the Zod schema for createDocument to discover all nested components
    pipeOutputSchemas.push(pipeOut)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isOptional = (fieldSchema as any)._zod?.def?.type === 'optional'
    // Look up description from the field schema or its inner schema (for optional wrappers)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldDef = (fieldSchema as any)._zod?.def
    const innerSchema =
      fieldDef?.type === 'optional' || fieldDef?.type === 'nullable'
        ? fieldDef.innerType
        : fieldSchema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (z.globalRegistry.get(fieldSchema as any) ??
      z.globalRegistry.get(innerSchema as any)) as Record<string, unknown> | undefined
    const description = meta?.description as string | undefined

    jsonParams.push({
      in: 'header',
      name: key,
      required: !isOptional,
      ...(description ? { description } : {}),
      content: { [contentType]: { schema: jsonSchema } },
    })
  }

  if (!hasJsonFields) return { specOp: op, pipeOutputSchemas: [] }

  const newRequestParams = { ...op.requestParams }
  if (Object.keys(plainShape).length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newRequestParams.header = z.object(plainShape) as any
  } else {
    delete newRequestParams.header
  }

  return {
    specOp: {
      ...op,
      requestParams: newRequestParams,
      parameters: [...((op.parameters as unknown[]) ?? []), ...jsonParams],
    },
    pipeOutputSchemas,
  }
}

function hasJsonContentHeaders(schema: AnyZod | undefined): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shape = (schema as any)?._zod?.def?.shape as Record<string, AnyZod> | undefined
  if (!shape) return false
  return Object.values(shape).some((fieldSchema) => getParamContentType(fieldSchema) !== undefined)
}

// ── Content-type-aware JSON body validator ───────────────────────
//
// Hono's built-in JSON validator is good for pure-JSON routes, but mixed-content
// endpoints need stricter media-type routing and case-insensitive matching. We
// validate JSON bodies here so multi-content routes can opt into exact
// `application/json` handling without affecting NDJSON or header-only requests.

async function parseJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new HTTPException(400, { message: 'Malformed JSON in request body' })
  }
}

async function validateJsonBody(
  c: Context,
  schema: AnyZod,
  value: unknown,
  hook: DefaultHook | undefined,
  next: () => Promise<void>
): Promise<Response | void> {
  const result = await schema.safeParseAsync(value)
  if (hook) {
    const hookResult = await hook({ data: value, ...result, target: 'json' }, c)
    if (hookResult) {
      if (hookResult instanceof Response) return hookResult
      if (typeof hookResult === 'object' && hookResult !== null && 'response' in hookResult) {
        return (hookResult as { response: Response }).response
      }
    }
  }

  if (!result.success) return c.json(result, 400)
  ;(
    c.req as typeof c.req & {
      addValidatedData: (target: 'json', data: z.output<AnyZod>) => void
    }
  ).addValidatedData('json', result.data)
  await next()
}

function strictJsonBodyValidator(schema: AnyZod, hook?: DefaultHook): MiddlewareHandler {
  return async (c, next) => {
    const contentType = c.req.header('content-type')
    const value = isJsonLikeContentType(contentType) ? await parseJsonBody(c) : {}
    return validateJsonBody(c, schema, value, hook, next)
  }
}

function contentTypeGuardedJsonValidator(schema: AnyZod, hook?: DefaultHook): MiddlewareHandler {
  return async (c, next) => {
    if (!isApplicationJsonContentType(c.req.header('content-type'))) {
      await next()
      return
    }

    const value = await parseJsonBody(c)
    return validateJsonBody(c, schema, value, hook, next)
  }
}

// ── Response validation ──────────────────────────────────────────

/**
 * Extract Zod schemas from a route's declared responses, keyed by status code.
 * Only picks up `application/json` content schemas that are Zod types.
 */
function extractResponseSchemas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses?: any
): Map<number, AnyZod> {
  const schemas = new Map<number, AnyZod>()
  if (!responses) return schemas

  for (const [statusCode, responseDef] of Object.entries(responses)) {
    const code = Number(statusCode)
    if (isNaN(code)) continue
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = (responseDef as any)?.content
    if (!content) continue
    const jsonContent = content['application/json']
    if (!jsonContent?.schema) continue
    // Only validate if the schema is a Zod type (has .parse)
    if (jsonContent.schema instanceof Object && 'parse' in jsonContent.schema) {
      schemas.set(code, jsonContent.schema as AnyZod)
    }
  }

  return schemas
}

/**
 * Middleware that validates JSON response bodies against declared Zod schemas.
 * On validation failure, replaces the response with a 500 containing error details.
 */
function responseValidationMiddleware(
  schemas: Map<number, AnyZod>
): MiddlewareHandler {
  return async (c, next) => {
    await next()

    const res = c.res
    const schema = schemas.get(res.status)
    if (!schema) return

    const contentType = res.headers.get('content-type')
    if (!contentType || !isJsonLikeContentType(contentType)) return

    const body = await res.clone().json()
    const result = schema.safeParse(body)
    if (!result.success) {
      c.res = new Response(
        JSON.stringify({
          error: 'Response validation failed',
          details: result.error.issues,
        }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      )
    }
  }
}

// ── OpenAPIHono ──────────────────────────────────────────────────

export class OpenAPIHono<
  E extends Env = Env,
  S extends Schema = {},
  BasePath extends string = '/',
> extends Hono<E, S, BasePath> {
  private _routes: Array<{ path: string; method: Method; op: ZodOpenApiOperationObject }> = []
  private _pipeOutputSchemas: AnyZod[] = []
  private _defaultHook?: DefaultHook

  constructor(options?: { defaultHook?: DefaultHook }) {
    super()
    this._defaultHook = options?.defaultHook
  }

  /**
   * Register an OpenAPI route. Co-locates the route spec with the handler:
   * - Wires up Zod validation middleware automatically
   * - Collects route metadata for getOpenAPI31Document()
   * - Handler receives typed c.req.valid('param'), c.req.valid('json'), etc.
   */
  openapi<R extends RouteConfig>(
    route: R,
    handler: Handler<E, ConvertPath<R['path']>, RouteInput<R>>
  ): this {
    const { method, path, hide, ...op } = route

    if (!hide) {
      // For spec: separate JSON content headers from plain headers.
      // Runtime validation uses the ORIGINAL op (transform+pipe handles JSON parsing).
      // Spec uses the modified specOp (JSON content fields become raw ParameterObjects).
      const { specOp, pipeOutputSchemas } = processJsonContentHeaders(op)
      this._routes.push({ path, method, op: specOp })
      this._pipeOutputSchemas.push(...pipeOutputSchemas)
    }

    const honoPath = toHonoPath(path)
    const middlewares: MiddlewareHandler[] = []

    // Wire up validation for each parameter location.
    // Note: we only validate params that are ZodType schemas.
    // Raw ParameterObject / ReferenceObject entries are spec-only and not validated.
    if (op.requestParams?.path instanceof Object && 'parse' in (op.requestParams.path as object)) {
      middlewares.push(
        zValidator('param', op.requestParams.path as AnyZod, this._defaultHook as never)
      )
    }
    if (
      op.requestParams?.query instanceof Object &&
      'parse' in (op.requestParams.query as object)
    ) {
      middlewares.push(
        zValidator('query', op.requestParams.query as AnyZod, this._defaultHook as never)
      )
    }
    if (
      op.requestParams?.header instanceof Object &&
      'parse' in (op.requestParams.header as object)
    ) {
      middlewares.push(
        zValidator('header', op.requestParams.header as AnyZod, this._defaultHook as never)
      )
    }
    if (
      op.requestParams?.cookie instanceof Object &&
      'parse' in (op.requestParams.cookie as object)
    ) {
      middlewares.push(
        zValidator('cookie', op.requestParams.cookie as AnyZod, this._defaultHook as never)
      )
    }

    // Only auto-validate application/json bodies — NDJSON and other streaming
    // content types are not parsed as a single JSON value.
    // Crucially, skip JSON body parsing entirely when the request's Content-Type
    // is not application/json, so NDJSON/header-only requests aren't affected.
    const requestBodyContent = op.requestBody?.content ?? {}
    const jsonSchema = requestBodyContent['application/json']?.schema
    const hasNonJsonRequestBody = Object.keys(requestBodyContent).some(
      (contentType) => contentType !== 'application/json'
    )
    const hasJsonHeaderAlternatives = hasJsonContentHeaders(op.requestParams?.header as AnyZod)
    if (jsonSchema instanceof Object && 'parse' in (jsonSchema as object)) {
      middlewares.push(
        hasNonJsonRequestBody || hasJsonHeaderAlternatives
          ? contentTypeGuardedJsonValidator(jsonSchema as AnyZod, this._defaultHook)
          : strictJsonBodyValidator(jsonSchema as AnyZod, this._defaultHook)
      )
    }

    // Response validation: extract Zod schemas from declared responses and validate
    // JSON response bodies after the handler runs. Returns 500 with error details on failure.
    const responseSchemas = extractResponseSchemas(op.responses)
    if (responseSchemas.size > 0) {
      middlewares.unshift(responseValidationMiddleware(responseSchemas))
    }

    // Use Hono's generic `on()` to avoid indexing by Method (which doesn't include `head`
    // in Hono's declared type even though the runtime supports it).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this.on as any)(
      method.toUpperCase(),
      honoPath as string,
      ...(middlewares as MiddlewareHandler[]),
      handler as Handler
    )

    return this
  }

  /**
   * Generate an OpenAPI 3.1 document from all registered routes.
   *
   * Pass `components` to pre-register named schemas (e.g. connector configs built
   * via z.fromJSONSchema + .meta({ id })) that are referenced in header contentSchema
   * annotations but don't appear directly in route request/response bodies.
   */
  getOpenAPI31Document(
    config: { info: ZodOpenApiObject['info'] } & Omit<ZodOpenApiObject, 'openapi' | 'paths'>,
    documentOptions?: CreateDocumentOptions
  ): ReturnType<typeof createDocument> {
    const paths: ZodOpenApiPathsObject = {}
    for (const { path, method, op } of this._routes) {
      if (!paths[path])
        paths[path] = {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(paths[path] as any)[method] = op
    }

    // Pass pipe output Zod schemas as component schemas so createDocument
    // recursively discovers all nested $ref schemas (discriminated union variants, etc.)
    const { info, components, ...rest } = config
    const pipeSchemas: Record<string, AnyZod> = {}
    for (const s of this._pipeOutputSchemas) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const meta = z.globalRegistry.get(s as any) as Record<string, unknown> | undefined
      const id = meta?.id as string | undefined
      if (id) pipeSchemas[id] = s
    }
    const mergedComponents: ZodOpenApiComponentsObject = {
      ...components,
      schemas: { ...components?.schemas, ...pipeSchemas },
    }
    return createDocument(
      {
        openapi: '3.1.0',
        info,
        paths,
        components: mergedComponents,
        ...rest,
      },
      {
        // Prevent zod-openapi from generating *Output duplicate schemas when the
        // same schema appears in both request and response positions.
        outputIdSuffix: '',
        ...documentOptions,
        // zod-openapi only emits discriminator.mapping (needs named $ref variants)
        // but omits discriminator.propertyName for inline variants. OAS 3.1 only
        // requires propertyName — inject it for any z.discriminatedUnion schema.
        override: ({ jsonSchema, zodSchema, ...ctx }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const def = (zodSchema as any)?._zod?.def
          if (def?.discriminator && !jsonSchema.discriminator) {
            jsonSchema.discriminator = { propertyName: def.discriminator }
          }
          return documentOptions?.override?.({ jsonSchema, zodSchema, ...ctx }) ?? jsonSchema
        },
      }
    )
  }
}

// ── createRoute ──────────────────────────────────────────────────

/**
 * Define a typed route config. Pass to app.openapi(route, handler).
 *
 * Preserves the full TypeScript type of R so handler inference works correctly.
 */
export function createRoute<R extends RouteConfig>(config: R): R {
  return config
}

export { isApplicationJsonContentType }

// ── Re-exports ───────────────────────────────────────────────────

// zod-openapi types consumers will need for route definitions
export type {
  ZodOpenApiOperationObject,
  ZodOpenApiObject,
  ZodOpenApiComponentsObject,
  ZodOpenApiPathsObject,
  ZodOpenApiResponsesObject,
  ZodOpenApiRequestBodyObject,
  ZodOpenApiParameters,
  CreateDocumentOptions,
} from 'zod-openapi'

// Hook type for custom validation error handlers
export type { Hook as ZodValidatorHook } from '@hono/zod-validator'

// Convenience: re-export ZodError for use in hooks
export type { ZodError }

// Re-export Input for consumers who need to type route inputs manually
export type { Input }
