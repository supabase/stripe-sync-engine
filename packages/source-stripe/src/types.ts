import type { ListFn, RetrieveFn } from '@stripe/sync-openapi'
import type { RevalidateEntityName } from './resourceRegistry.js'

/**
 * Simple logger interface compatible with both pino and console
 */
export interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

/**
 * Syncable resource configuration
 */
export type BaseResourceConfig = {
  /** Backfill order: lower numbers sync first; parents before children for FK dependencies */
  order: number
  /** Database table name for this resource (e.g. 'customers', 'invoices') */
  tableName: string
  /** Whether this resource supports incremental sync via 'created' filter or cursor */
  supportsCreatedFilter: boolean
  /** Whether this resource is included in sync runs by default. Default: true */
  sync?: boolean
  /** Resource types that must be backfilled before this one (e.g. price depends on product) */
  dependencies?: readonly string[]
  /** Function to check if an entity is in a final state and doesn't need revalidation */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isFinalState?: (entity: any) => boolean
}

export type ResourceConfig = BaseResourceConfig & {
  listFn?: ListFn
  retrieveFn?: RetrieveFn
  /** Whether the list API supports the `limit` parameter */
  supportsLimit?: boolean
  /** Nested child resources discovered from the spec (e.g. subscription items under subscriptions) */
  nestedResources?: {
    tableName: string
    resourceId: string
    apiPath: string
    parentParamName: string
    supportsPagination: boolean
  }[]
  /** For nested resources, the parent path parameter name */
  parentParamName?: string
}

export type RevalidateEntity = RevalidateEntityName

export const SUPPORTED_WEBHOOK_EVENTS: string[] = [
  'charge.captured',
  'charge.expired',
  'charge.failed',
  'charge.pending',
  'charge.refunded',
  'charge.succeeded',
  'charge.updated',
  'customer.deleted',
  'customer.created',
  'customer.updated',
  'coupon.created',
  'coupon.deleted',
  'coupon.updated',
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'customer.subscription.trial_will_end',
  'customer.subscription.resumed',
  'customer.subscription.updated',
  'customer.tax_id.updated',
  'customer.tax_id.created',
  'customer.tax_id.deleted',
  'invoice.created',
  'invoice.deleted',
  'invoice.finalized',
  'invoice.finalization_failed',
  'invoice.paid',
  'invoice.payment_action_required',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.upcoming',
  'invoice.sent',
  'invoice.voided',
  'invoice.marked_uncollectible',
  'invoice.updated',
  'product.created',
  'product.updated',
  'product.deleted',
  'price.created',
  'price.updated',
  'price.deleted',
  'plan.created',
  'plan.updated',
  'plan.deleted',
  'setup_intent.canceled',
  'setup_intent.created',
  'setup_intent.requires_action',
  'setup_intent.setup_failed',
  'setup_intent.succeeded',
  'subscription_schedule.aborted',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.created',
  'subscription_schedule.expiring',
  'subscription_schedule.released',
  'subscription_schedule.updated',
  'payment_method.attached',
  'payment_method.automatically_updated',
  'payment_method.detached',
  'payment_method.updated',
  'charge.dispute.created',
  'charge.dispute.funds_reinstated',
  'charge.dispute.funds_withdrawn',
  'charge.dispute.updated',
  'charge.dispute.closed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.canceled',
  'payment_intent.created',
  'payment_intent.partially_funded',
  'payment_intent.payment_failed',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'payment_intent.succeeded',
  'credit_note.created',
  'credit_note.updated',
  'credit_note.voided',
  'radar.early_fraud_warning.created',
  'radar.early_fraud_warning.updated',
  'refund.created',
  'refund.failed',
  'refund.updated',
  'charge.refund.updated',
  'review.closed',
  'review.opened',
  'entitlements.active_entitlement_summary.updated',
]
