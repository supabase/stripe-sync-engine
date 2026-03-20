export { VERSION } from './version'

// Re-export core protocol types for consumers
export type {
  Source,
  Destination,
  Stream,
  ConfiguredStream,
  ConfiguredCatalog,
  ConnectorSpecification,
  CheckResult,
  RecordMessage,
  StateMessage,
  CatalogMessage,
  LogMessage,
  ErrorMessage,
  StreamStatusMessage,
  DestinationInput,
  DestinationOutput,
  Message,
  SyncEngineParams,
} from '@stripe/sync-protocol'

export { createEngine } from '@stripe/sync-protocol'

export type { SyncParams, ConnectorResolver, ConnectorResolverOptions } from '@stripe/sync-service'
export { createConnectorResolver, resolveSpecifier, loadConnector } from '@stripe/sync-service'
