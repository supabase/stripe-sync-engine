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
export type { EntitySchema } from './streams/types'
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

// Webhook
export { StripeSyncWebhook } from './stripeSyncWebhook'
export type { StripeSyncWebhookDeps, WebhookConfig } from './stripeSyncWebhook'
export type { WebhookWriter } from './webhookWriter'

// Worker
export { StripeSyncWorker } from './stripeSyncWorker'
export type { WorkerTaskManager, SyncTask, RunKey, WorkerConfig } from './stripeSyncWorker'

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

// Schemas
export { activeEntitlementSchema } from './streams/active_entitlement'
export { chargeSchema } from './streams/charge'
export { checkoutSessionLineItemSchema } from './streams/checkout_session_line_items'
export { checkoutSessionSchema, checkoutSessionDeletedSchema } from './streams/checkout_sessions'
export { creditNoteSchema } from './streams/credit_note'
export { customerSchema, customerDeletedSchema } from './streams/customer'
export { disputeSchema } from './streams/dispute'
export { earlyFraudWarningSchema } from './streams/early_fraud_warning'
export { featureSchema } from './streams/feature'
export { invoiceSchema } from './streams/invoice'
export { managedWebhookSchema } from './streams/managed_webhook'
export { paymentIntentSchema } from './streams/payment_intent'
export { paymentMethodsSchema } from './streams/payment_methods'
export { planSchema } from './streams/plan'
export { priceSchema } from './streams/price'
export { productSchema } from './streams/product'
export { refundSchema } from './streams/refund'
export { reviewSchema } from './streams/review'
export { setupIntentsSchema } from './streams/setup_intents'
export { subscriptionItemSchema } from './streams/subscription_item'
export { subscriptionScheduleSchema } from './streams/subscription_schedules'
export { subscriptionSchema } from './streams/subscription'
export { taxIdSchema } from './streams/tax_id'
