export { VERSION } from './version.js'

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
  RegisteredConnectors,
  ResolvedConnector,
} from '@stripe/sync-lib-stateless'

export {
  createEngine,
  createEngineFromParams,
  createConnectorResolver,
  resolveSpecifier,
  resolveBin,
  createSourceFromExec,
  createDestinationFromExec,
  parseNdjsonStream,
} from '@stripe/sync-lib-stateless'

export { ndjsonResponse } from '@stripe/sync-ts-cli/ndjson'
