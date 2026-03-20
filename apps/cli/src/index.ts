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
  SyncParams,
  ConnectorResolver,
  ConnectorResolverOptions,
} from '@stripe/sync-protocol'

export {
  createEngine,
  createConnectorResolver,
  resolveSpecifier,
  loadConnector,
} from '@stripe/sync-protocol'
