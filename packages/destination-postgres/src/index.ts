// CLI
export type { DestinationCliOptions } from './cli'
export { main as cliMain } from './cli'

export { DestinationWriter } from './destinationWriter'
export { PostgresDestination } from './postgresDestination'
export { PostgresDestinationWriter } from './writer'
export { QueryUtils, type InsertColumn } from './QueryUtils'
export { METADATA_TABLES, type PostgresConfig, type RawJsonUpsertOptions } from './types'
