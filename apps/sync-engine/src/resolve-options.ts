import type { SyncParams as SyncParamsType } from '@stripe/stateless-sync'
import { SyncParams } from '@stripe/stateless-sync'
import { envPrefix, mergeConfig, parseJsonOrFile } from '@stripe/ts-cli'

export interface CliOptions {
  // Stripe flags
  stripeApiKey?: string
  stripeBaseUrl?: string
  websocket?: boolean
  backfillLimit?: number
  // Postgres flags
  postgresUrl?: string
  postgresSchema?: string
  // Sync flags
  streams?: string
  state?: boolean // Commander inverts --no-state → state: false
  // Generic escape hatches
  source?: string
  destination?: string
  sourceConfig?: string
  destinationConfig?: string
  config?: string
}

/** Parse comma-separated stream names into the streams array format. */
function parseStreams(value: string | undefined): Array<{ name: string }> | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name }))
}

/** Infer source connector name from flags. */
function inferSourceName(opts: CliOptions): string {
  if (opts.source) return opts.source
  if (opts.stripeApiKey || process.env['STRIPE_API_KEY']) return 'stripe'
  return 'stripe' // default
}

/** Infer destination connector name from flags. */
function inferDestinationName(opts: CliOptions): string | undefined {
  if (opts.destination) return opts.destination
  if (opts.postgresUrl || process.env['POSTGRES_URL'] || process.env['DATABASE_URL'])
    return 'postgres'
  return undefined
}

/** Build source config from connector-prefixed flags + env shortcuts + generic env. */
function buildSourceConfig(opts: CliOptions): Record<string, unknown> {
  const fromFlags: Record<string, unknown> = {}
  if (opts.stripeApiKey) fromFlags['api_key'] = opts.stripeApiKey
  if (opts.stripeBaseUrl) fromFlags['base_url'] = opts.stripeBaseUrl
  if (opts.websocket) fromFlags['websocket'] = opts.websocket
  if (opts.backfillLimit != null) fromFlags['backfill_limit'] = opts.backfillLimit

  const fromEnvShortcuts: Record<string, unknown> = {}
  if (process.env['STRIPE_API_KEY']) fromEnvShortcuts['api_key'] = process.env['STRIPE_API_KEY']

  return mergeConfig(
    fromFlags,
    fromEnvShortcuts,
    envPrefix('SOURCE'),
    parseJsonOrFile(opts.sourceConfig)
  )
}

/** Build destination config from connector-prefixed flags + env shortcuts + generic env. */
function buildDestinationConfig(opts: CliOptions, isPostgres: boolean): Record<string, unknown> {
  const fromFlags: Record<string, unknown> = {}
  if (isPostgres) {
    if (opts.postgresUrl) fromFlags['url'] = opts.postgresUrl
    if (opts.postgresSchema) fromFlags['schema'] = opts.postgresSchema
  }

  const fromEnvShortcuts: Record<string, unknown> = {}
  if (isPostgres) {
    const envUrl = process.env['POSTGRES_URL'] ?? process.env['DATABASE_URL']
    if (envUrl) fromEnvShortcuts['url'] = envUrl
  }

  return mergeConfig(
    fromFlags,
    fromEnvShortcuts,
    envPrefix('DESTINATION'),
    parseJsonOrFile(opts.destinationConfig)
  )
}

/** Resolve CLI options into SyncParams. */
export function resolveOptions(opts: CliOptions): SyncParamsType {
  const fileConfig = parseJsonOrFile(opts.config)

  const sourceName = inferSourceName(opts)
  const destinationName = inferDestinationName(opts) ?? (fileConfig.destination_name as string)

  if (!destinationName) {
    console.error(
      'Error: destination not specified. Use --postgres-url, --destination, or set POSTGRES_URL.'
    )
    process.exit(1)
  }

  const sourceConfig = mergeConfig(
    buildSourceConfig(opts),
    fileConfig.source_config as Record<string, unknown> | undefined
  )

  const isPostgres = destinationName === 'postgres' || destinationName === 'destination-postgres'

  const destinationConfig = mergeConfig(
    buildDestinationConfig(opts, isPostgres),
    fileConfig.destination_config as Record<string, unknown> | undefined,
    isPostgres ? { schema: 'stripe' } : {} // default schema for postgres only
  )

  try {
    return SyncParams.parse({
      source_name: sourceName,
      destination_name: destinationName,
      source_config: sourceConfig,
      destination_config: destinationConfig,
      streams: parseStreams(opts.streams) ?? fileConfig.streams,
      state: fileConfig.state,
    })
  } catch (err) {
    console.error('Failed to resolve sync params:', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

/** Extract the Postgres connection URL from resolved destination config. */
export function getPostgresUrl(destConfig: Record<string, unknown>): string | undefined {
  return (destConfig['url'] as string) ?? (destConfig['connection_string'] as string)
}

/** Extract the Postgres schema from resolved destination config. */
export function getPostgresSchema(destConfig: Record<string, unknown>): string {
  return (destConfig['schema'] as string) ?? 'stripe'
}
