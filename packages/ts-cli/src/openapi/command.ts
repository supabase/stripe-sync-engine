import { Command } from 'commander'
import { buildRequest, handleResponse } from './dispatch.js'
import type { Handler } from './dispatch.js'
import { defaultOperationName, parseSpec, toCliFlag, type ParsedOperation } from './parse.js'
import type { OpenAPIOperation, OpenAPISpec } from './types.js'

export type { Handler }

export interface CreateCliFromSpecOptions {
  /** OpenAPI 3.0 spec object */
  spec: OpenAPISpec
  /** Web-standard request handler */
  handler: Handler
  /** Override command name derivation */
  nameOperation?: (method: string, path: string, operation: OpenAPIOperation) => string
  /** Exclude specific operationIds */
  exclude?: string[]
  /** Group commands under subcommands by OpenAPI tag */
  groupByTag?: boolean
  /** Base URL for constructing Request objects (default: 'http://localhost') */
  baseUrl?: string
  /** Provider for NDJSON request body stream. Called when operation.ndjsonRequest === true.
   * Return a ReadableStream to use as body, or null/undefined to fall back to --body flag. */
  ndjsonBodyStream?: () => ReadableStream | null | undefined
}

/** Returns a Commander Command with subcommands for each API operation. */
export function createCliFromSpec(opts: CreateCliFromSpecOptions): Command {
  const {
    spec,
    handler,
    nameOperation,
    exclude = [],
    groupByTag = false,
    baseUrl = 'http://localhost',
    ndjsonBodyStream,
  } = opts

  const root = new Command()
  root.allowUnknownOption(false)

  const operations = parseSpec(spec).filter(
    (op) => !op.operationId || !exclude.includes(op.operationId)
  )

  if (groupByTag) {
    // Group by first tag
    const groups = new Map<string, ParsedOperation[]>()
    const ungrouped: ParsedOperation[] = []

    for (const op of operations) {
      const tag = op.tags[0]
      if (tag) {
        const list = groups.get(tag) ?? []
        list.push(op)
        groups.set(tag, list)
      } else {
        ungrouped.push(op)
      }
    }

    for (const [tag, ops] of groups) {
      const group = new Command(toCliFlag(tag))
      for (const op of ops) {
        group.addCommand(buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream))
      }
      root.addCommand(group)
    }

    for (const op of ungrouped) {
      root.addCommand(buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream))
    }
  } else {
    for (const op of operations) {
      root.addCommand(buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream))
    }
  }

  return root
}

/** Build a single Commander Command from a ParsedOperation. */
export function buildCommand(
  operation: ParsedOperation,
  handler: Handler,
  baseUrl = 'http://localhost',
  nameOverride?: (method: string, path: string, op: OpenAPIOperation) => string,
  ndjsonBodyStream?: () => ReadableStream | null | undefined
): Command {
  const rawOp: OpenAPIOperation = {
    operationId: operation.operationId,
    tags: operation.tags,
    parameters: [...operation.pathParams, ...operation.queryParams, ...operation.headerParams],
    requestBody: operation.bodySchema
      ? {
          required: operation.bodyRequired,
          content: { 'application/json': { schema: operation.bodySchema } },
        }
      : undefined,
  }

  const name = nameOverride
    ? nameOverride(operation.method, operation.path, rawOp)
    : defaultOperationName(operation.method, operation.path, rawOp)

  const cmd = new Command(name)

  // Path params become positional arguments
  for (const param of operation.pathParams) {
    if (param.required !== false) {
      cmd.argument(`<${param.name}>`, param.description ?? '')
    } else {
      cmd.argument(`[${param.name}]`, param.description ?? '')
    }
  }

  // Query params become --flags
  for (const param of operation.queryParams) {
    const flag = toCliFlag(param.name)
    const required = param.required === true
    const valuePlaceholder = required ? `<${param.name}>` : `[${param.name}]`
    if (required) {
      cmd.requiredOption(`--${flag} ${valuePlaceholder}`, param.description ?? '')
    } else {
      cmd.option(`--${flag} ${valuePlaceholder}`, param.description ?? '')
    }
  }

  // Header params become --flags (kebab-cased)
  for (const param of operation.headerParams) {
    const flag = toCliFlag(param.name)
    const required = param.required === true
    const valuePlaceholder = required ? `<${param.name}>` : `[${param.name}]`
    if (required) {
      cmd.requiredOption(`--${flag} ${valuePlaceholder}`, param.description ?? '')
    } else {
      cmd.option(`--${flag} ${valuePlaceholder}`, param.description ?? '')
    }
  }

  // Body: per-property flags for flat objects, --body for complex/NDJSON
  if (operation.bodySchema) {
    const props = operation.bodySchema.properties
    if (props && !operation.ndjsonRequest) {
      const requiredFields = operation.bodySchema.required ?? []
      for (const [propName, propSchema] of Object.entries(props)) {
        const flag = toCliFlag(propName)
        const isRequired = requiredFields.includes(propName)
        const desc = propSchema.description ?? ''
        const valuePlaceholder = isRequired ? `<${propName}>` : `[${propName}]`
        if (isRequired) {
          cmd.requiredOption(`--${flag} ${valuePlaceholder}`, desc)
        } else {
          cmd.option(`--${flag} ${valuePlaceholder}`, desc)
        }
      }
    } else {
      // Complex or NDJSON body: single --body flag.
      // When ndjsonBodyStream is provided, --body is optional for NDJSON operations
      // because the stream supplies the body at runtime; the API enforces presence.
      const bodyOptional = operation.ndjsonRequest && ndjsonBodyStream !== undefined
      if (operation.bodyRequired && !bodyOptional) {
        cmd.requiredOption('--body <json>', 'Request body as JSON string')
      } else {
        cmd.option('--body [json]', 'Request body as JSON string')
      }
    }
  }

  cmd.action(async (...actionArgs: unknown[]) => {
    // Commander passes positional args first, then opts object, then command
    const positionals = actionArgs.slice(0, operation.pathParams.length) as string[]
    const opts = actionArgs[operation.pathParams.length] as Record<string, string | undefined>

    let request = buildRequest(operation, positionals, opts, baseUrl)

    if (operation.ndjsonRequest && ndjsonBodyStream) {
      const stream = ndjsonBodyStream()
      if (stream) {
        const headers = new Headers(request.headers)
        headers.set('Content-Type', 'application/x-ndjson')
        headers.set('Transfer-Encoding', 'chunked')
        request = new Request(request.url, {
          method: request.method,
          headers,
          body: stream,
          // Node.js requires duplex:'half' for streaming request bodies
          duplex: 'half',
        } as RequestInit)
      }
    }

    const response = await handler(request)
    await handleResponse(response, operation)
  })

  return cmd
}
