import type { Source, Destination } from './protocol'
import { validateSource, validateDestination } from './validate'

/**
 * Resolve a short connector name to a full package specifier.
 *
 * - File paths (starting with `.` or `/`) and scoped packages (containing `/`) pass through.
 * - Bare names resolve to `@stripe/source-<name>` or `@stripe/destination-<name>`.
 */
export function resolveSpecifier(name: string, role: 'source' | 'destination'): string {
  if (name.startsWith('.') || name.startsWith('/') || name.includes('/')) return name
  return `@stripe/${role}-${name}`
}

/**
 * Load a connector by specifier. Optionally auto-installs missing npm packages.
 *
 * Resolution:
 * 1. `import()` the specifier
 * 2. If MODULE_NOT_FOUND and `installFn` is provided, call it and retry
 * 3. Validate using `validateSource` or `validateDestination` from validate.ts
 */
export async function loadConnector(
  specifier: string,
  role: 'source' | 'destination',
  options?: { installFn?: (pkg: string) => void }
): Promise<Source | Destination> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(specifier)) as Record<string, unknown>
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      if (options?.installFn) {
        console.error(`"${specifier}" not found. Installing...`)
        options.installFn(specifier)
        mod = (await import(specifier)) as Record<string, unknown>
      } else {
        throw new Error(
          `Connector "${specifier}" not found. Install it with: pnpm add ${specifier}`
        )
      }
    } else {
      throw err
    }
  }

  const connector = mod.default ?? mod
  const validate = role === 'source' ? validateSource : validateDestination
  const result = validate(connector)
  if (!result.valid) {
    throw new Error(
      `Connector "${specifier}" failed ${role} conformance check:\n${result.errors.join('\n')}`
    )
  }
  return connector as Source | Destination
}

// MARK: - ConnectorResolver

export interface ConnectorResolverOptions {
  /** Preloaded connectors — skip dynamic loading for these. */
  sources?: Record<string, Source>
  /** Preloaded connectors — skip dynamic loading for these. */
  destinations?: Record<string, Destination>
  /** Auto-install missing connectors. Called with the package specifier. */
  installFn?: (pkg: string) => void
}

export interface ConnectorResolver {
  resolveSource(name: string): Promise<Source>
  resolveDestination(name: string): Promise<Destination>
}

/**
 * Create a caching connector resolver.
 *
 * Three loading modes:
 * 1. **Preloaded** — passed in `options.sources` / `options.destinations`. Always available.
 * 2. **Cached auto-load** — first request calls `loadConnector()`, result is cached.
 * 3. **Auto-install** — if `installFn` is provided, missing packages are installed before loading.
 */
export function createConnectorResolver(options: ConnectorResolverOptions): ConnectorResolver {
  const sourceCache = new Map<string, Source>(Object.entries(options.sources ?? {}))
  const destCache = new Map<string, Destination>(Object.entries(options.destinations ?? {}))

  return {
    async resolveSource(name: string): Promise<Source> {
      const cached = sourceCache.get(name)
      if (cached) return cached

      const specifier = resolveSpecifier(name, 'source')
      const connector = (await loadConnector(specifier, 'source', {
        installFn: options.installFn,
      })) as Source
      sourceCache.set(name, connector)
      return connector
    },

    async resolveDestination(name: string): Promise<Destination> {
      const cached = destCache.get(name)
      if (cached) return cached

      const specifier = resolveSpecifier(name, 'destination')
      const connector = (await loadConnector(specifier, 'destination', {
        installFn: options.installFn,
      })) as Destination
      destCache.set(name, connector)
      return connector
    },
  }
}
