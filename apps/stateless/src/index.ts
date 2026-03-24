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
  SyncParams,
  ConnectorResolver,
  ConnectorResolverOptions,
  ResolvedConnector,
} from '@tx-stripe/stateless-sync'

export {
  createEngine,
  createEngineFromParams,
  createConnectorResolver,
  resolveSpecifier,
  resolveBin,
  sourceExec,
  destinationExec,
  parseNdjsonStream,
} from '@tx-stripe/stateless-sync'

export { ndjsonResponse } from './stream'
