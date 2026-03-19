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
export type { EntitySchema } from './schemas/types'
export type { Source } from '@stripe/sync-protocol'

// Source
export { StripeSource } from './stripeSource'

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
export { catalogFromRegistry } from './catalog'

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

// Schemas
export { activeEntitlementSchema } from './schemas/active_entitlement'
export { chargeSchema } from './schemas/charge'
export { checkoutSessionLineItemSchema } from './schemas/checkout_session_line_items'
export { checkoutSessionSchema, checkoutSessionDeletedSchema } from './schemas/checkout_sessions'
export { creditNoteSchema } from './schemas/credit_note'
export { customerSchema, customerDeletedSchema } from './schemas/customer'
export { disputeSchema } from './schemas/dispute'
export { earlyFraudWarningSchema } from './schemas/early_fraud_warning'
export { featureSchema } from './schemas/feature'
export { invoiceSchema } from './schemas/invoice'
export { managedWebhookSchema } from './schemas/managed_webhook'
export { paymentIntentSchema } from './schemas/payment_intent'
export { paymentMethodsSchema } from './schemas/payment_methods'
export { planSchema } from './schemas/plan'
export { priceSchema } from './schemas/price'
export { productSchema } from './schemas/product'
export { refundSchema } from './schemas/refund'
export { reviewSchema } from './schemas/review'
export { setupIntentsSchema } from './schemas/setup_intents'
export { subscriptionItemSchema } from './schemas/subscription_item'
export { subscriptionScheduleSchema } from './schemas/subscription_schedules'
export { subscriptionSchema } from './schemas/subscription'
export { taxIdSchema } from './schemas/tax_id'
