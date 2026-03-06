import Stripe from 'stripe'
import type { ResourceConfig, StripeListResourceConfig } from './types'
import type { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'

interface ResourceDef {
  readonly order: number
  readonly tableName: string
  readonly dependencies?: readonly string[]
  readonly list: (
    s: Stripe
  ) => (
    p: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam }
  ) => Promise<{ data: unknown[]; has_more: boolean }>
  readonly retrieve: (s: Stripe) => (id: string) => Promise<Stripe.Response<unknown>>
  readonly supportsCreatedFilter: boolean
  readonly sync: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly isFinalState?: (entity: any) => boolean
  // Tables created from nested data (like line items) that don't have their own top-level list API.
  readonly childTables?: readonly string[]
  readonly listExpands?: readonly Record<
    string,
    (s: Stripe) => (id: string) => Promise<Stripe.ApiList<{ id?: string }>>
  >[]
}

const RESOURCE_MAP: Record<string, ResourceDef> = {
  product: {
    order: 1,
    tableName: 'products',
    list: (s) => (p) => s.products.list(p),
    retrieve: (s) => (id) => s.products.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
  },
  price: {
    order: 2,
    tableName: 'prices',
    dependencies: ['product'],
    list: (s) => (p) => s.prices.list(p),
    retrieve: (s) => (id) => s.prices.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
  },
  plan: {
    order: 3,
    tableName: 'plans',
    dependencies: ['product'],
    list: (s) => (p) => s.plans.list(p),
    retrieve: (s) => (id) => s.plans.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
  },
  customer: {
    order: 4,
    tableName: 'customers',
    list: (s) => (p) => s.customers.list(p),
    retrieve: (s) => (id) => s.customers.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (c: Stripe.Customer | Stripe.DeletedCustomer) =>
      'deleted' in c && c.deleted === true,
  },
  subscription: {
    order: 5,
    tableName: 'subscriptions',
    dependencies: ['customer', 'price'],
    list: (s) => (p) => s.subscriptions.list(p),
    retrieve: (s) => (id) => s.subscriptions.retrieve(id),
    listExpands: [
      { items: (s) => (id) => s.subscriptionItems.list({ subscription: id, limit: 100 }) },
    ],
    supportsCreatedFilter: true,
    sync: true,
    childTables: ['subscription_items'],
    isFinalState: (s: Stripe.Subscription) =>
      s.status === 'canceled' || s.status === 'incomplete_expired',
  },
  subscription_schedules: {
    order: 6,
    tableName: 'subscription_schedules',
    dependencies: ['customer'],
    list: (s) => (p) => s.subscriptionSchedules.list(p),
    retrieve: (s) => (id) => s.subscriptionSchedules.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (s: Stripe.SubscriptionSchedule) =>
      s.status === 'canceled' || s.status === 'completed',
  },
  invoice: {
    order: 7,
    tableName: 'invoices',
    dependencies: ['customer', 'subscription'],
    list: (s) => (p) => s.invoices.list(p),
    retrieve: (s) => (id) => s.invoices.retrieve(id),
    listExpands: [{ lines: (s) => (id) => s.invoices.listLineItems(id, { limit: 100 }) }],
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (i: Stripe.Invoice) => i.status === 'void',
  },
  charge: {
    order: 8,
    tableName: 'charges',
    dependencies: ['customer', 'invoice'],
    list: (s) => (p) => s.charges.list(p),
    retrieve: (s) => (id) => s.charges.retrieve(id),
    listExpands: [{ refunds: (s) => (id) => s.refunds.list({ charge: id, limit: 100 }) }],
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (c: Stripe.Charge) => c.status === 'failed' || c.status === 'succeeded',
  },
  setup_intent: {
    order: 9,
    tableName: 'setup_intents',
    dependencies: ['customer'],
    list: (s) => (p) => s.setupIntents.list(p),
    retrieve: (s) => (id) => s.setupIntents.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (s: Stripe.SetupIntent) => s.status === 'canceled' || s.status === 'succeeded',
  },
  payment_method: {
    order: 10,
    tableName: 'payment_methods',
    dependencies: ['customer'],
    list: (s) => (p) => s.paymentMethods.list(p),
    retrieve: (s) => (id) => s.paymentMethods.retrieve(id),
    supportsCreatedFilter: false,
    sync: true,
  },
  payment_intent: {
    order: 11,
    tableName: 'payment_intents',
    dependencies: ['customer', 'invoice'],
    list: (s) => (p) => s.paymentIntents.list(p),
    retrieve: (s) => (id) => s.paymentIntents.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (p: Stripe.PaymentIntent) => p.status === 'canceled' || p.status === 'succeeded',
  },
  tax_id: {
    order: 12,
    tableName: 'tax_ids',
    dependencies: ['customer'],
    list: (s) => (p) => s.taxIds.list(p),
    retrieve: (s) => (id) => s.taxIds.retrieve(id),
    supportsCreatedFilter: false,
    sync: true,
  },
  credit_note: {
    order: 13,
    tableName: 'credit_notes',
    dependencies: ['customer', 'invoice'],
    list: (s) => (p) => s.creditNotes.list(p),
    retrieve: (s) => (id) => s.creditNotes.retrieve(id),
    listExpands: [{ lines: (s) => (id) => s.creditNotes.listLineItems(id, { limit: 100 }) }],
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (c: Stripe.CreditNote) => c.status === 'void',
  },
  dispute: {
    order: 14,
    tableName: 'disputes',
    dependencies: ['charge'],
    list: (s) => (p) => s.disputes.list(p),
    retrieve: (s) => (id) => s.disputes.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
    isFinalState: (d: Stripe.Dispute) => d.status === 'won' || d.status === 'lost',
  },
  early_fraud_warning: {
    order: 15,
    tableName: 'early_fraud_warnings',
    dependencies: ['payment_intent', 'charge'],
    list: (s) => (p) => s.radar.earlyFraudWarnings.list(p),
    retrieve: (s) => (id) => s.radar.earlyFraudWarnings.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
  },
  refund: {
    order: 16,
    tableName: 'refunds',
    dependencies: ['payment_intent', 'charge'],
    list: (s) => (p) => s.refunds.list(p),
    retrieve: (s) => (id) => s.refunds.retrieve(id),
    supportsCreatedFilter: true,
    sync: true,
  },
  checkout_sessions: {
    order: 17,
    tableName: 'checkout_sessions',
    dependencies: ['customer', 'subscription', 'payment_intent', 'invoice'],
    list: (s) => (p) => s.checkout.sessions.list(p),
    retrieve: (s) => (id) => s.checkout.sessions.retrieve(id),
    listExpands: [{ lines: (s) => (id) => s.checkout.sessions.listLineItems(id, { limit: 100 }) }],
    supportsCreatedFilter: true,
    sync: true,
    childTables: ['checkout_session_line_items'],
  },
  active_entitlements: {
    order: 18,
    tableName: 'active_entitlements',
    dependencies: ['customer'],
    list: (s) => (p) =>
      s.entitlements.activeEntitlements.list(p as Stripe.Entitlements.ActiveEntitlementListParams),
    retrieve: (s) => (id) => s.entitlements.activeEntitlements.retrieve(id),
    supportsCreatedFilter: true,
    sync: false,
  },
  review: {
    order: 19,
    tableName: 'reviews',
    dependencies: ['payment_intent', 'charge'],
    list: (s) => (p) => s.reviews.list(p),
    retrieve: (s) => (id) => s.reviews.retrieve(id),
    supportsCreatedFilter: true,
    sync: false,
  },
} satisfies Record<string, ResourceDef>

// Union of all object keys defined in RESOURCE_MAP. Used as the canonical object-name type across sync and registry helpers.
export type StripeObject = keyof typeof RESOURCE_MAP

// Sync-enabled objects derived from RESOURCE_MAP metadata.
// Used for default full-sync selection and SyncObjectName composition.
export const CORE_SYNC_OBJECTS = Object.keys(RESOURCE_MAP).filter(
  (k) => RESOURCE_MAP[k].sync
) as StripeObject[]

// Type for one sync-enabled object key (excludes pseudo objects).
// Used where callers must operate on concrete sync resources only.
export type CoreSyncObject = (typeof CORE_SYNC_OBJECTS)[number]

// Public sync object options including pseudo entries like "all".
// Used by sync input typing/validation for object selection.
export const SYNC_OBJECTS = ['all', 'customer_with_entitlements', ...CORE_SYNC_OBJECTS] as const

// Type of valid sync object input values.
// Used by exported config/types and CLI/object selection paths.
export type SyncObjectName = (typeof SYNC_OBJECTS)[number]

// Entity names accepted for webhook revalidation overrides.
// Used by StripeSyncConfig.revalidateObjectsViaStripeApi typing.
export const REVALIDATE_ENTITIES = [
  ...Object.keys(RESOURCE_MAP),
  'radar.early_fraud_warning',
  'subscription_schedule',
  'entitlements',
] as const
// Type for a single revalidation entity name.
// Used by RevalidateEntity in shared sync config types.
export type RevalidateEntityName = (typeof REVALIDATE_ENTITIES)[number]

// Tables that must exist for runtime sync and webhook processing.
// Used by migration/spec filtering to assert required schema coverage.
export const RUNTIME_REQUIRED_TABLES: ReadonlyArray<string> = Array.from(
  new Set([
    ...Object.values(RESOURCE_MAP).map((r) => r.tableName),
    ...Object.values(RESOURCE_MAP).flatMap((r) => r.childTables ?? []),
    'features', // from customer_with_entitlements
  ])
)

// Canonical table names for each RESOURCE_MAP object key.
// Used by OpenAPI/runtime adapters to avoid duplicating table mappings.
export const RESOURCE_TABLE_NAME_MAP = Object.fromEntries(
  Object.entries(RESOURCE_MAP).map(([objectName, def]) => [objectName, def.tableName])
) as Record<StripeObject, string>

// Builds runtime ResourceConfig objects from RESOURCE_MAP + Stripe client.
// Used by StripeSync constructor to initialize this.resourceRegistry.
export function buildResourceRegistry(stripe: Stripe): Record<StripeObject, ResourceConfig> {
  return Object.fromEntries(
    Object.entries(RESOURCE_MAP).map(([key, def]) => {
      const config: StripeListResourceConfig = {
        order: def.order,
        tableName: def.tableName,
        supportsCreatedFilter: def.supportsCreatedFilter,
        sync: def.sync,
        dependencies: def.dependencies ? [...def.dependencies] : [],
        isFinalState: def.isFinalState,
        listFn: def.list(stripe),
        retrieveFn: def.retrieve(stripe),
        listExpands: def.listExpands?.map((expand) =>
          Object.fromEntries(Object.entries(expand).map(([prop, fn]) => [prop, fn(stripe)]))
        ),
      }
      return [key, config]
    })
  ) as Record<StripeObject, ResourceConfig>
}

// Builds Sigma registry entries ordered after core resource ordering.
// Used by StripeSync constructor to initialize this.sigmaRegistry.
export function buildSigmaRegistry(
  sigma: SigmaSyncProcessor,
  coreRegistry: Record<string, ResourceConfig>
): Record<string, ResourceConfig> {
  const maxOrder = Math.max(...Object.values(coreRegistry).map((cfg) => cfg.order))
  return sigma.buildSigmaRegistryEntries(maxOrder)
}

// Alias map from Stripe event object names to internal registry keys.
// Used by normalizeStripeObjectName during webhook/upsert ingestion.
export const STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES: Record<string, StripeObject> = {
  'checkout.session': 'checkout_sessions',
  'radar.early_fraud_warning': 'early_fraud_warning',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'active_entitlements',
  subscription_schedule: 'subscription_schedules',
}

// Converts Stripe object names into canonical RESOURCE_MAP keys.
// Used before config/table lookups in webhook and sync flows.
export function normalizeStripeObjectName(stripeObjectName: string): StripeObject {
  const normalizedObjectName =
    STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES[stripeObjectName] ?? stripeObjectName
  return normalizedObjectName as StripeObject
}

// Maps Stripe ID prefixes (e.g. cus_) to registry object names.
// Used when we only have an ID and need to resolve resource type.
export const PREFIX_RESOURCE_MAP: Record<string, StripeObject> = {
  cus_: 'customer',
  gcus_: 'customer',
  in_: 'invoice',
  price_: 'price',
  prod_: 'product',
  sub_: 'subscription',
  seti_: 'setup_intent',
  pm_: 'payment_method',
  dp_: 'dispute',
  du_: 'dispute',
  ch_: 'charge',
  pi_: 'payment_intent',
  txi_: 'tax_id',
  cn_: 'credit_note',
  issfr_: 'early_fraud_warning',
  prv_: 'review',
  re_: 'refund',
  feat_: 'active_entitlements',
  cs_: 'checkout_sessions',
}

// Prefixes sorted longest-first to avoid partial-prefix collisions.
// Used by getResourceFromPrefix for deterministic prefix matching.
const SORTED_PREFIXES = Object.keys(PREFIX_RESOURCE_MAP).sort((a, b) => b.length - a.length)

// Resolves a Stripe ID string to a registry object key by prefix.
// Used by getResourceConfigFromId and single-entity sync routing.
export function getResourceFromPrefix(stripeId: string): string | undefined {
  const prefix = SORTED_PREFIXES.find((p) => stripeId.startsWith(p))
  return prefix ? (PREFIX_RESOURCE_MAP[prefix] as string) : undefined
}

// Gets ResourceConfig for a raw Stripe ID like cus_/ch_/pi_.
// Used by StripeSync.syncSingleEntity to pick retrieve/upsert behavior.
export function getResourceConfigFromId(
  stripeId: string,
  registry: Record<string, ResourceConfig>
): ResourceConfig | undefined {
  const resourceName = getResourceFromPrefix(stripeId)
  return resourceName ? registry[resourceName] : undefined
}

// Resolves table name for a canonical object key in a registry.
// Used by webhook and worker paths before writing to Postgres.
export function getTableName(object: string, registry: Record<string, ResourceConfig>): string {
  const config = registry[object]
  if (!config) throw new Error(`No resource config found for object type: ${object}`)
  return config.tableName
}
