import { readFileSync } from 'node:fs'

/**
 * Scan process.env for vars with the given prefix, strip prefix,
 * lowercase field names, JSON-parse values where possible.
 *
 *   envPrefix('SOURCE')
 *   // SOURCE_API_KEY=sk_test_... → { api_key: "sk_test_..." }
 *   // SOURCE_BASE_URL=http://... → { base_url: "http://..." }
 */
export function envPrefix(prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const pfx = prefix + '_'

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(pfx) || value === undefined) continue
    const field = key.slice(pfx.length).toLowerCase()
    result[field] = tryJsonParse(value)
  }

  return result
}

/**
 * Load a JSON config file. Returns {} if path is undefined.
 * Throws with a clear message if file doesn't exist or isn't valid JSON.
 */
export function configFromFile(path: string | undefined): Record<string, unknown> {
  if (path === undefined) return {}

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new Error(`Config file not found: ${path}`)
    }
    throw err
  }

  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config file must contain a JSON object: ${path}`)
    }
    return parsed as Record<string, unknown>
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}`)
    }
    throw err
  }
}

/**
 * Merge config objects in priority order (first source wins per key).
 * Shallow merge — later sources fill in missing keys only.
 *
 *   mergeConfig(cliFlags, envVars, fileConfig, defaults)
 */
export function mergeConfig(
  ...sources: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const source of sources) {
    if (!source) continue
    for (const [key, value] of Object.entries(source)) {
      if (!(key in result)) {
        result[key] = value
      }
    }
  }

  return result
}

/**
 * Parse a value as inline JSON or read it as a file path.
 * If the string starts with `{` or `[`, parse as JSON.
 * Otherwise, treat as a file path and read + parse.
 * Returns {} if value is undefined.
 */
export function parseJsonOrFile(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {}
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  return configFromFile(trimmed)
}

/** Try to JSON-parse a string value. Returns the original string if parsing fails. */
function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
