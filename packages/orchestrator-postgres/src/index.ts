// CLI
export type { OrchestratorCliOptions } from './cli'
export { main as cliMain } from './cli'

export { PostgresOrchestrator, type Sync } from './orchestrator'
export { PostgresStateManager, type StateManagerConfig } from './stateManager'
export { forward, collect, type RouterCallbacks } from './router'

// Pipeline
export { runPipeline, type PipelineOrchestrator } from './pipeline'

// Sync types
export type {
  SyncStatus,
  StreamConfig,
  StripeApiCoreSource,
  SourceConfig,
  PostgresDestination,
  DestinationConfig,
} from './syncTypes'
export type { Sync as SyncResource } from './syncTypes'

// Bridge
export { syncFromBridgeInput, type SyncBridgeInput } from './bridge'
