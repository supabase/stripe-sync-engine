import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Source, Destination } from '@tx-stripe/protocol'
import { ConnectorSpecification } from '@tx-stripe/protocol'
import { sourceExec } from './source-exec'
import { destinationExec } from './destination-exec'

// MARK: - Validation

type ValidationResult = { valid: true } | { valid: false; errors: string[] }

/** Runtime-check that `obj` satisfies the Source interface contract. */
export function validateSource(obj: unknown): ValidationResult {
  const errors: string[] = []

  if (obj == null || typeof obj !== 'object') {
    return { valid: false, errors: ['default export is not an object'] }
  }

  const o = obj as Record<string, unknown>

  // Required methods
  for (const method of ['spec', 'check', 'discover', 'read'] as const) {
    if (typeof o[method] !== 'function') {
      errors.push(`missing required method: ${method}()`)
    }
  }

  // Optional methods — must be functions if present
  for (const method of ['setup', 'teardown'] as const) {
    if (method in o && typeof o[method] !== 'function') {
      errors.push(`${method} is present but not a function`)
    }
  }

  // Validate spec() output
  if (typeof o['spec'] === 'function') {
    validateSpec(o['spec'] as () => unknown, errors)
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

/** Runtime-check that `obj` satisfies the Destination interface contract. */
export function validateDestination(obj: unknown): ValidationResult {
  const errors: string[] = []

  if (obj == null || typeof obj !== 'object') {
    return { valid: false, errors: ['default export is not an object'] }
  }

  const o = obj as Record<string, unknown>

  // Required methods
  for (const method of ['spec', 'check', 'write'] as const) {
    if (typeof o[method] !== 'function') {
      errors.push(`missing required method: ${method}()`)
    }
  }

  // Optional methods — must be functions if present
  for (const method of ['setup', 'teardown'] as const) {
    if (method in o && typeof o[method] !== 'function') {
      errors.push(`${method} is present but not a function`)
    }
  }

  // Validate spec() output
  if (typeof o['spec'] === 'function') {
    validateSpec(o['spec'] as () => unknown, errors)
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors }
}

function validateSpec(specFn: () => unknown, errors: string[]) {
  let specResult: unknown
  try {
    specResult = specFn()
  } catch (err) {
    errors.push(`spec() threw: ${err}`)
    return
  }

  const parsed = ConnectorSpecification.safeParse(specResult)
  if (!parsed.success) {
    errors.push(`spec() returned invalid ConnectorSpecification: ${parsed.error.message}`)
  }
}

// MARK: - Specifier resolution

/**
 * Resolve a short connector name to a full package specifier.
 *
 * - File paths (starting with `.` or `/`) and scoped packages (containing `/`) pass through.
 * - Bare names resolve to `@tx-stripe/source-<name>` or `@tx-stripe/destination-<name>`.
 */
export function resolveSpecifier(name: string, role: 'source' | 'destination'): string {
  if (name.startsWith('.') || name.startsWith('/') || name.includes('/')) return name
  return `@tx-stripe/${role}-${name}`
}

// MARK: - Subprocess bin resolution

/**
 * Resolve a connector name + role to a bin path.
 *
 * Search order:
 * 1. Walk up from cwd checking node_modules/.bin (covers npm-installed packages)
 * 2. Walk up from cwd checking node_modules/<pkg>/package.json bin field
 *    (covers pnpm workspace links where .bin entries aren't created)
 * 3. Scan PATH directories (covers pnpm exec/run which adds the right .bin to PATH)
 */
export function resolveBin(name: string, role: 'source' | 'destination'): string | undefined {
  const binName = `${role}-${name}`
  const pkgName = resolveSpecifier(name, role)

  // Walk up from cwd checking each node_modules/.bin
  let dir = process.cwd()
  while (true) {
    const candidate = join(dir, 'node_modules', '.bin', binName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Walk up from cwd checking workspace-linked package bin fields
  // (pnpm workspace links don't always create .bin entries)
  dir = process.cwd()
  while (true) {
    const pkgJsonPath = join(dir, 'node_modules', pkgName, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
        const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
        if (binEntry) {
          const resolved = join(dir, 'node_modules', pkgName, binEntry)
          if (existsSync(resolved)) return resolved
        }
      } catch {
        // malformed package.json — skip
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Scan PATH directories
  const pathDirs = (process.env['PATH'] ?? '').split(':')
  for (const pathDir of pathDirs) {
    if (!pathDir) continue
    const candidate = join(pathDir, binName)
    if (existsSync(candidate)) return candidate
  }

  return undefined
}

// MARK: - ConnectorResolver

/**
 * Controls which dynamic resolution strategies are enabled beyond the registered
 * (in-process) connectors. Maps 1:1 to CLI flags and JSON config fields.
 *
 * CLI:   --connectors-from-path    --connectors-from-npm    --connectors-from-command-map
 * TS:    connectorsFromPath         connectorsFromNpm         connectorsFromCommandMap
 * JSON:  connectors_from_path      connectors_from_npm       connectors_from_command_map
 */
export interface ConnectorsFrom {
  /**
   * Find binaries matching `source-*` / `destination-*` in `node_modules/.bin` and `PATH`.
   * Default: `true`.
   */
  path?: boolean
  /**
   * Download `@tx-stripe/source-*` / `@tx-stripe/destination-*` from npm.
   * Default: `false`.
   */
  npm?: boolean
  /**
   * Explicit name→command mappings. Keys: `"source-<name>"` or `"destination-<name>"`.
   * The command is spawned as a subprocess speaking the connector NDJSON protocol.
   */
  commandMap?: Record<string, string>
}

export interface ConnectorResolverOptions {
  /** Preloaded connectors — skip dynamic loading for these. */
  sources?: Record<string, Source>
  /** Preloaded connectors — skip dynamic loading for these. */
  destinations?: Record<string, Destination>
}

export type ResolvedConnector<T> = { connector: T; configSchema: z.ZodType }

export interface ConnectorResolver {
  resolveSource(name: string): Promise<Source>
  resolveDestination(name: string): Promise<Destination>
  /** Eagerly resolved source connectors with their config schemas. */
  sources(): ReadonlyMap<string, ResolvedConnector<Source>>
  /** Eagerly resolved destination connectors with their config schemas. */
  destinations(): ReadonlyMap<string, ResolvedConnector<Destination>>
}

/** Convert a connector's spec().config JSON Schema to a Zod object schema. */
function configSchemaFromSpec(connector: {
  spec(): { config: Record<string, unknown> }
}): z.ZodType {
  const schema = z.fromJSONSchema(connector.spec().config)
  // fromJSONSchema({}) returns ZodAny — fall back to empty object for composability
  if (schema instanceof z.ZodObject) return schema
  return z.object({})
}

/**
 * Create a caching connector resolver.
 *
 * Resolution order:
 * 1. **Registered** — in-process connectors passed in `registered`. Always checked first.
 * 2. **commandMap** — explicit name→command mappings in `connectorsFrom.commandMap`.
 * 3. **path** — `node_modules/.bin` / PATH scan (enabled unless `connectorsFrom.path === false`).
 * 4. **npm** — `npx @tx-stripe/source-<name>` auto-download (disabled unless `connectorsFrom.npm`).
 * 5. **Error** — connector not found.
 */
export function createConnectorResolver(
  registered: ConnectorResolverOptions,
  connectorsFrom?: ConnectorsFrom
): ConnectorResolver {
  const sourceCache = new Map<string, Source>(Object.entries(registered.sources ?? {}))
  const destCache = new Map<string, Destination>(Object.entries(registered.destinations ?? {}))

  // Build schema maps from all known connectors
  const _sources = new Map<string, ResolvedConnector<Source>>()
  for (const [name, connector] of sourceCache) {
    _sources.set(name, { connector, configSchema: configSchemaFromSpec(connector) })
  }
  const _destinations = new Map<string, ResolvedConnector<Destination>>()
  for (const [name, connector] of destCache) {
    _destinations.set(name, { connector, configSchema: configSchemaFromSpec(connector) })
  }

  /**
   * Get the command string for a connector via dynamic resolution strategies.
   * All three strategies (commandMap, path, npm) produce the same output: a command
   * string passed directly to sourceExec/destinationExec. Multi-word commands
   * (e.g. "npx @tx-stripe/source-stripe") are split by subprocess.ts at spawn time.
   */
  function resolveVia(name: string, role: 'source' | 'destination'): string | undefined {
    const key = `${role}-${name}`

    // commandMap: explicit name→command mapping
    const mapped = connectorsFrom?.commandMap?.[key]
    if (mapped) return mapped

    // path: find binary in node_modules/.bin or PATH
    if (connectorsFrom?.path !== false) {
      const bin = resolveBin(name, role)
      if (bin) return bin
    }

    // npm: download from @stripe scope via npx
    if (connectorsFrom?.npm) {
      return `npx @tx-stripe/${role}-${name}`
    }

    return undefined
  }

  return {
    async resolveSource(name: string): Promise<Source> {
      const cached = sourceCache.get(name)
      if (cached) return cached

      const cmd = resolveVia(name, 'source')
      if (cmd) {
        const connector = sourceExec(cmd)
        sourceCache.set(name, connector)
        _sources.set(name, { connector, configSchema: configSchemaFromSpec(connector) })
        return connector
      }

      throw new Error(
        `Source connector "${name}" not found. Register it or install @tx-stripe/source-${name}.`
      )
    },

    async resolveDestination(name: string): Promise<Destination> {
      const cached = destCache.get(name)
      if (cached) return cached

      const cmd = resolveVia(name, 'destination')
      if (cmd) {
        const connector = destinationExec(cmd)
        destCache.set(name, connector)
        _destinations.set(name, { connector, configSchema: configSchemaFromSpec(connector) })
        return connector
      }

      throw new Error(
        `Destination connector "${name}" not found. Register it or install @tx-stripe/destination-${name}.`
      )
    },

    sources() {
      return _sources
    },
    destinations() {
      return _destinations
    },
  }
}
