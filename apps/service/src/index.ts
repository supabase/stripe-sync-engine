// Barrel — re-exports for consumers of @stripe/sync-service

// Schemas (Zod + inferred types)
export { createSchemas } from './lib/createSchemas.js'
export type {
  SourceConfig,
  DestinationConfig,
  StreamConfig,
  Pipeline,
  CreatePipeline,
  UpdatePipeline,
  LogEntry,
} from './lib/createSchemas.js'

// API app factory
export { createApp } from './api/app.js'
export type { AppOptions } from './api/app.js'

// Temporal workflow types (for consumers that need to reference them)
export { createActivities } from './temporal/activities/index.js'
export type { SyncActivities } from './temporal/activities/index.js'
export type { PipelineStatus } from './lib/createSchemas.js'
export { createWorker } from './temporal/worker.js'
export type { WorkerOptions } from './temporal/worker.js'
