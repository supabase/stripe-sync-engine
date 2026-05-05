/**
 * Overrides for x-resourceId values whose table name cannot be inferred by the
 * default snake_case + dot-to-underscore rule in SpecParser.resolveTableName.
 * Values are singular, mirroring Stripe resource names (rule #2 of the schema spec).
 */
export const OPENAPI_RESOURCE_TABLE_ALIASES: Record<string, string> = {
  'radar.early_fraud_warning': 'early_fraud_warning',
  'entitlements.active_entitlement': 'active_entitlement',
  'entitlements.feature': 'feature',
  item: 'checkout_session_line_item',
}
