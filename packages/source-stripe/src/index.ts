// CLI
export type { SourceCliOptions } from './cli'
export { main as cliMain } from './cli'

// Types
export type {
  BaseResourceConfig,
  StripeListResourceConfig,
  ResourceConfig,
  Logger,
  RevalidateEntity,
  ProcessNextResult,
} from './types'
export { SUPPORTED_WEBHOOK_EVENTS } from './types'
export type { Source } from '@stripe/sync-protocol'

// Source
export {
  default,
  spec,
  type Config,
  type WebhookInput,
  type StripeStreamState,
  createSource,
  fromWebhookEvent,
} from './backfill'

// Resource Registry
export {
  buildResourceRegistry,
  normalizeStripeObjectName,
  getTableName,
  getResourceConfigFromId,
  getResourceFromPrefix,
  CORE_SYNC_OBJECTS,
  SYNC_OBJECTS,
  REVALIDATE_ENTITIES,
  RESOURCE_TABLE_NAME_MAP,
  RUNTIME_REQUIRED_TABLES,
  STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES,
  PREFIX_RESOURCE_MAP,
} from './resourceRegistry'
export type {
  StripeObject,
  CoreSyncObject,
  SyncObjectName,
  RevalidateEntityName,
} from './resourceRegistry'
// WebSocket
export { createStripeWebSocketClient } from './websocket-client'
export type {
  StripeWebSocketClient,
  StripeWebSocketOptions,
  WebhookProcessingResult,
  WebhookResponse,
  StripeWebhookEvent,
} from './websocket-client'

// Catalog
export { catalogFromRegistry, catalogFromOpenApi } from './catalog'

// Transforms
export {
  backfillDependencies,
  expandLists,
  syncSubscriptionItems,
  upsertSubscriptionItems,
} from './transforms'

// Utils
export { expandEntity } from './utils/expandEntity'
export { hashApiKey } from './utils/hashApiKey'

// OpenAPI spec → JSON Schema
export type * from './openapi/types'
export {
  SpecParser,
  OPENAPI_RESOURCE_TABLE_ALIASES,
  RUNTIME_RESOURCE_ALIASES,
} from './openapi/specParser'
export { OPENAPI_COMPATIBILITY_COLUMNS } from './openapi/runtimeMappings'
export { resolveOpenApiSpec } from './openapi/specFetchHelper'
export { parsedTableToJsonSchema } from './openapi/jsonSchemaConverter'
