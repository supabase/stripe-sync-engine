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
import { createDocument } from 'zod-openapi'
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

// ── OpenAPIHono ──────────────────────────────────────────────────

export class OpenAPIHono<
  E extends Env = Env,
  S extends Schema = {},
  BasePath extends string = '/',
> extends Hono<E, S, BasePath> {
  private _routes: Array<{ path: string; method: Method; op: ZodOpenApiOperationObject }> = []
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
      this._routes.push({ path, method, op })
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
    const jsonSchema = op.requestBody?.content?.['application/json']?.schema
    if (jsonSchema instanceof Object && 'parse' in (jsonSchema as object)) {
      middlewares.push(zValidator('json', jsonSchema as AnyZod, this._defaultHook as never))
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

    const { info, components, ...rest } = config
    return createDocument(
      {
        openapi: '3.1.0',
        info,
        paths,
        components,
        ...rest,
      },
      documentOptions
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
