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
} from '@stripe/stateless-sync'

export {
  createEngine,
  createConnectorResolver,
  resolveSpecifier,
  loadConnector,
} from '@stripe/stateless-sync'
export type {
  SyncParams,
  ConnectorResolver,
  ConnectorResolverOptions,
} from '@stripe/stateless-sync'
