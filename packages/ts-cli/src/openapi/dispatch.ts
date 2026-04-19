import type { ParsedOperation } from './parse.js'

/** Web-standard handler: takes a Request, returns a Response. */
export type Handler = (req: Request) => Promise<Response>

/**
 * Build a web-standard Request from CLI arguments and a parsed operation.
 *
 * - Substitutes path params into the URL
 * - Appends query params as a query string
 * - Sets header params on the request
 * - Serializes body (JSON object or raw JSON string for --body flag)
 */
export function buildRequest(
  operation: ParsedOperation,
  /** Positional args in path-param order */
  args: string[],
  /** Named options from Commander */
  opts: Record<string, string | undefined>,
  baseUrl = 'http://localhost'
): Request {
  // Substitute path params
  let urlPath = operation.path
  for (let i = 0; i < operation.pathParams.length; i++) {
    const param = operation.pathParams[i]!
    const value = args[i]
    if (value !== undefined) {
      urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(value))
    }
  }

  // Build query string
  const url = new URL(urlPath, baseUrl)
  for (const param of operation.queryParams) {
    const flagName = toOptName(param.name)
    const value = opts[flagName]
    if (value !== undefined) {
      url.searchParams.set(param.name, value)
    }
  }

  // Build headers
  const headers = new Headers()
  for (const param of operation.headerParams) {
    const flagName = toOptName(param.name)
    const value = opts[flagName]
    if (value !== undefined) {
      headers.set(param.name, value)
    }
  }

  // Build body
  let body: string | undefined
  const contentType = operation.ndjsonRequest ? 'application/x-ndjson' : 'application/json'

  if (operation.bodySchema) {
    // If body schema has top-level properties, collect --flag values
    const props = operation.bodySchema.properties
    if (props && !operation.ndjsonRequest) {
      const bodyObj: Record<string, unknown> = {}
      for (const propName of Object.keys(props)) {
        const flagName = toOptName(propName)
        const value = opts[flagName]
        if (value !== undefined) {
          bodyObj[propName] = tryJsonParse(value)
        }
      }
      if (Object.keys(bodyObj).length > 0) {
        body = JSON.stringify(bodyObj)
        headers.set('Content-Type', 'application/json')
      }
    } else if (opts['body'] !== undefined) {
      // Complex/NDJSON body: pass raw via --body
      body = opts['body']
      headers.set('Content-Type', contentType)
    }
  }

  return new Request(url.toString(), {
    method: operation.method.toUpperCase(),
    headers,
    body: body ?? (hasBody(operation.method) ? null : undefined),
  })
}

/**
 * Handle a Response: route JSON, NDJSON, 204, and errors to the right output.
 * Writes to process.stdout / process.stderr and calls process.exit(1) on error.
 */
export async function handleResponse(
  response: Response,
  operation: ParsedOperation
): Promise<void> {
  if (!response.ok) {
    const text = await response.text()
    let formatted = text
    try {
      const json = JSON.parse(text)
      if (json.error && json.details) {
        // Response validation error — show structured output
        const issues = (json.details as Array<{ path: string[]; message: string }>)
          .slice(0, 10)
          .map((d) => `  ${d.path.join('.')}: ${d.message}`)
          .join('\n')
        const more = json.details.length > 10 ? `\n  ... and ${json.details.length - 10} more` : ''
        formatted = `${json.error}\n${issues}${more}`
      } else if (json.error) {
        formatted = typeof json.error === 'string' ? json.error : JSON.stringify(json.error, null, 2)
      } else {
        formatted = JSON.stringify(json, null, 2)
      }
    } catch {
      // not JSON, use raw text
    }
    process.stderr.write(`Error ${response.status}: ${formatted}\n`)
    process.exit(1)
  }

  if (response.status === 204 || operation.noContent) {
    return
  }

  const contentType = response.headers.get('content-type') ?? ''

  if (operation.ndjsonResponse || contentType.includes('x-ndjson')) {
    // Stream NDJSON lines to stdout
    if (response.body) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) process.stdout.write(line + '\n')
        }
      }
      if (buffer.trim()) process.stdout.write(buffer + '\n')
    }
    return
  }

  if (contentType.includes('application/json')) {
    const data = await response.json()
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }

  // Fallback: write raw text
  const text = await response.text()
  if (text) process.stdout.write(text + '\n')
}

/** Convert a param name to Commander option key (camelCase of kebab-case flag). */
export function toOptName(name: string): string {
  // Commander stores --foo-bar as opts.fooBar
  return name
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function hasBody(method: string): boolean {
  return ['post', 'put', 'patch'].includes(method.toLowerCase())
}

function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
