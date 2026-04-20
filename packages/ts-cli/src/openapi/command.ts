import { defineCommand } from 'citty'
import type { ArgDef, CommandDef } from 'citty'
import { buildRequest, handleResponse, toOptName } from './dispatch.js'
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
  /** CLI metadata for the root command */
  meta?: { name?: string; description?: string; version?: string }
  /** Extra args to declare on the root command (e.g. --data-dir for help text) */
  rootArgs?: Record<string, ArgDef>
  /** Descriptions for tag groups (used with groupByTag). Keyed by tag name (after any renaming). */
  tagDescriptions?: Record<string, string>
  /** Custom response formatter. Replaces default handleResponse for all JSON responses. */
  responseFormatter?: (response: Response, operation: ParsedOperation) => Promise<void>
}

/** Returns a citty CommandDef with subcommands for each API operation. */
export function createCliFromSpec(opts: CreateCliFromSpecOptions): CommandDef {
  const {
    spec,
    handler,
    nameOperation,
    exclude = [],
    groupByTag = false,
    baseUrl = 'http://localhost',
    ndjsonBodyStream,
    meta,
    rootArgs,
    tagDescriptions = {},
    responseFormatter,
  } = opts

  // Build tag description lookup: explicit tagDescriptions override spec-level tags
  const specTagDescs: Record<string, string> = {}
  for (const t of spec.tags ?? []) {
    if (t.description) specTagDescs[t.name] = t.description
  }
  const tagDescs = { ...specTagDescs, ...tagDescriptions }

  const operations = parseSpec(spec).filter(
    (op) => !op.operationId || !exclude.includes(op.operationId)
  )

  const subCommands: Record<string, CommandDef> = {}

  if (groupByTag) {
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
      const groupSubCommands: Record<string, CommandDef> = {}
      for (const op of ops) {
        const name = getOpName(op, nameOperation)
        groupSubCommands[name] = buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream, responseFormatter)
      }
      const cliTag = toCliFlag(tag)
      subCommands[cliTag] = defineCommand({
        meta: { name: cliTag, description: tagDescs[tag] ?? tagDescs[cliTag] },
        subCommands: groupSubCommands,
      })
    }

    for (const op of ungrouped) {
      const name = getOpName(op, nameOperation)
      subCommands[name] = buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream, responseFormatter)
    }
  } else {
    for (const op of operations) {
      const name = getOpName(op, nameOperation)
      subCommands[name] = buildCommand(op, handler, baseUrl, nameOperation, ndjsonBodyStream, responseFormatter)
    }
  }

  return defineCommand({
    meta: meta
      ? { name: meta.name, description: meta.description, version: meta.version }
      : undefined,
    args: rootArgs,
    subCommands,
  })
}

function getOpName(
  op: ParsedOperation,
  nameOverride?: (method: string, path: string, op: OpenAPIOperation) => string
): string {
  const rawOp: OpenAPIOperation = {
    operationId: op.operationId,
    tags: op.tags,
    parameters: [...op.pathParams, ...op.queryParams, ...op.headerParams],
    requestBody: op.bodySchema
      ? {
          required: op.bodyRequired,
          content: { 'application/json': { schema: op.bodySchema } },
        }
      : undefined,
  }
  return nameOverride
    ? nameOverride(op.method, op.path, rawOp)
    : defaultOperationName(op.method, op.path, rawOp)
}

function hasAlternativeJsonHeader(operation: ParsedOperation, propName: string): boolean {
  const normalizedProp = toCliFlag(propName)
  return operation.headerParams.some((param) => {
    if (!param.content?.['application/json']) return false
    return toCliFlag(param.name).replace(/^x-/, '') === normalizedProp
  })
}

/** Build a single citty CommandDef from a ParsedOperation. */
export function buildCommand(
  operation: ParsedOperation,
  handler: Handler,
  baseUrl = 'http://localhost',
  nameOverride?: (method: string, path: string, op: OpenAPIOperation) => string,
  ndjsonBodyStream?: () => ReadableStream | null | undefined,
  responseFormatter?: (response: Response, operation: ParsedOperation) => Promise<void>
): CommandDef {
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

  const args: Record<string, ArgDef> = {}

  // Path params become positional args
  for (const param of operation.pathParams) {
    args[param.name] = {
      type: 'positional',
      required: param.required !== false,
      description: param.description ?? '',
    }
  }

  // Query params become --flags (camelCase key → kebab-case flag)
  for (const param of operation.queryParams) {
    const key = toOptName(param.name)
    args[key] = {
      type: 'string',
      required: param.required === true,
      description: param.description ?? '',
    }
  }

  // Header params become --flags (camelCase key → kebab-case flag)
  for (const param of operation.headerParams) {
    const key = toOptName(param.name)
    args[key] = {
      type: 'string',
      required: param.required === true,
      description: param.description ?? '',
    }
  }

  // Body: per-property flags for flat objects, --body for complex/NDJSON
  if (operation.bodySchema) {
    const props = operation.bodySchema.properties
    if (props && !operation.ndjsonRequest) {
      const requiredFields = operation.bodySchema.required ?? []
      for (const [propName, propSchema] of Object.entries(props)) {
        const key = toOptName(propName)
        args[key] = {
          type: 'string',
          required:
            requiredFields.includes(propName) && !hasAlternativeJsonHeader(operation, propName),
          description: propSchema.description ?? '',
        }
      }
    } else {
      // Complex or NDJSON body: single --body flag.
      // When ndjsonBodyStream is provided, --body is optional for NDJSON operations.
      const bodyOptional = operation.ndjsonRequest && ndjsonBodyStream !== undefined
      args['body'] = {
        type: 'string',
        required: operation.bodyRequired === true && !bodyOptional,
        description: 'Request body as JSON string',
      }
    }
  }

  return defineCommand({
    meta: { name, description: operation.summary },
    args,
    async run({ args: cmdArgs }) {
      // Extract positionals in path-param order, options from flat args object
      const positionals = operation.pathParams.map(
        (p) => (cmdArgs as Record<string, string>)[p.name]
      )
      const opts = cmdArgs as Record<string, string | undefined>

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
      if (responseFormatter) {
        await responseFormatter(response, operation)
      } else {
        await handleResponse(response, operation)
      }
    },
  })
}

/** Convert flag key (camelCase) back to --kebab-case for display/testing. */
export { toCliFlag }
