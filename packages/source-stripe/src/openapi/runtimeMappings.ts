import type { ParsedColumn } from './types.js'

/**
 * Canonical mapping of resource registry object keys to Postgres table names.
 * Inlined from the resource registry to keep destination-postgres free of source-stripe deps.
 */
const RESOURCE_TABLE_NAME_MAP: Record<string, string> = {
  product: 'products',
  coupon: 'coupons',
  price: 'prices',
  plan: 'plans',
  customer: 'customers',
  subscription: 'subscriptions',
  subscription_schedules: 'subscription_schedules',
  invoice: 'invoices',
  charge: 'charges',
  setup_intent: 'setup_intents',
  payment_method: 'payment_methods',
  payment_intent: 'payment_intents',
  tax_id: 'tax_ids',
  credit_note: 'credit_notes',
  dispute: 'disputes',
  early_fraud_warning: 'early_fraud_warnings',
  refund: 'refunds',
  checkout_sessions: 'checkout_sessions',
  active_entitlements: 'active_entitlements',
  review: 'reviews',
}

/**
 * Alias map from Stripe event object names to internal registry keys.
 * Inlined from the resource registry to keep destination-postgres free of source-stripe deps.
 */
const STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES: Record<string, string> = {
  'checkout.session': 'checkout_sessions',
  'radar.early_fraud_warning': 'early_fraud_warning',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'active_entitlements',
  subscription_schedule: 'subscription_schedules',
}

const OPENAPI_ADDITIONAL_RESOURCE_TABLE_ALIASES: Record<string, string> = {
  // OpenAPI resource id differs from runtime sync object routing for this nested entitlement schema.
  'entitlements.feature': 'features',
  // OpenAPI uses generic "item" for checkout session line items.
  item: 'checkout_session_line_items',
}

const OPENAPI_RESOURCE_TABLE_ALIASES_FROM_REGISTRY: Record<string, string> = Object.fromEntries(
  Object.entries(RESOURCE_TABLE_NAME_MAP).map(([objectName, tableName]) => [objectName, tableName])
)

const OPENAPI_RESOURCE_TABLE_ALIASES_FROM_STRIPE_OBJECT_ALIASES: Record<string, string> =
  Object.fromEntries(
    Object.entries(STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES).map(
      ([stripeObjectName, syncObjectName]) => [
        stripeObjectName,
        RESOURCE_TABLE_NAME_MAP[syncObjectName],
      ]
    )
  )

/**
 * OpenAPI resource-id to runtime table-name aliases.
 */
export const OPENAPI_RESOURCE_TABLE_ALIASES: Record<string, string> = {
  ...OPENAPI_RESOURCE_TABLE_ALIASES_FROM_REGISTRY,
  ...OPENAPI_RESOURCE_TABLE_ALIASES_FROM_STRIPE_OBJECT_ALIASES,
  ...OPENAPI_ADDITIONAL_RESOURCE_TABLE_ALIASES,
}

/**
 * Compatibility columns that should exist even if not present in the current OpenAPI shape.
 * This preserves backwards compatibility for existing queries and write paths.
 * todo: Remove this
 */
export const OPENAPI_COMPATIBILITY_COLUMNS: Record<string, ParsedColumn[]> = {
  active_entitlements: [
    { name: 'customer', type: 'text', nullable: true },
    { name: 'object', type: 'text', nullable: true },
    { name: 'feature', type: 'text', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
  ],
  checkout_session_line_items: [
    { name: 'checkout_session', type: 'text', nullable: true },
    { name: 'amount_discount', type: 'bigint', nullable: true },
    { name: 'amount_tax', type: 'bigint', nullable: true },
  ],
  customers: [{ name: 'deleted', type: 'boolean', nullable: true }],
  early_fraud_warnings: [{ name: 'payment_intent', type: 'text', nullable: true }],
  features: [
    { name: 'object', type: 'text', nullable: true },
    { name: 'name', type: 'text', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
    { name: 'active', type: 'boolean', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'metadata', type: 'json', nullable: true },
  ],
  subscription_items: [
    { name: 'deleted', type: 'boolean', nullable: true },
    { name: 'subscription', type: 'text', nullable: true },
  ],
}
