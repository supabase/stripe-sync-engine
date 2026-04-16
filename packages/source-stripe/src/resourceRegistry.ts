import type { ResourceConfig } from './types.js'
import type { ListFn, ListParams, OpenApiSpec, NestedEndpoint } from '@stripe/sync-openapi'
import {
  discoverListEndpoints,
  discoverNestedEndpoints,
  buildListFn,
  buildRetrieveFn,
  isV2Path,
  resolveTableName,
  OPENAPI_RESOURCE_TABLE_ALIASES,
} from '@stripe/sync-openapi'
import { tracedFetch } from './transport.js'
import { withHttpRetry } from './retry.js'

const apiFetch: typeof globalThis.fetch = (input, init) =>
  tracedFetch(input as URL | string, init ?? {})

/**
 * Wrap a raw list function so only params the endpoint actually supports are forwarded.
 * Some Stripe endpoints (e.g. reporting_report_types) don't accept `limit` or
 * `starting_after`; sending them causes 400 errors.
 */
function buildSpecAwareListFn(
  baseListFn: ListFn,
  options: {
    isV2: boolean
    supportsLimit: boolean
    supportsStartingAfter: boolean
    supportsEndingBefore: boolean
    supportsCreatedFilter: boolean
  }
): ListFn {
  return (params: ListParams) => {
    const next: ListParams = {}
    if (options.supportsLimit && params.limit != null) {
      next.limit = params.limit
    }
    if ((options.isV2 || options.supportsStartingAfter) && params.starting_after) {
      next.starting_after = params.starting_after
    }
    if (options.supportsEndingBefore && params.ending_before) {
      next.ending_before = params.ending_before
    }
    if (options.supportsCreatedFilter && params.created) {
      next.created = params.created
    }
    return baseListFn(next)
  }
}

/**
 * The default set of table names synced when no explicit selection is made.
 * These correspond to the resources that were previously hardcoded with sync: true.
 */
export const DEFAULT_SYNC_OBJECTS: readonly string[] = [
  'products',
  'coupons',
  'prices',
  'plans',
  'customers',
  'subscriptions',
  'subscription_schedules',
  'invoices',
  'charges',
  'setup_intents',
  'payment_methods',
  'payment_intents',
  'tax_ids',
  'credit_notes',
  'disputes',
  'early_fraud_warnings',
  'refunds',
  'checkout_sessions',
]

export const REVALIDATE_ENTITIES = [
  ...DEFAULT_SYNC_OBJECTS,
  'radar.early_fraud_warning',
  'subscription_schedule',
  'entitlements',
] as const
export type RevalidateEntityName = (typeof REVALIDATE_ENTITIES)[number]

/**
 * Build a ResourceConfig for every listable resource discovered in the OpenAPI spec.
 * All resources get list + retrieve functions derived dynamically from the spec paths.
 */
export function buildResourceRegistry(
  spec: OpenApiSpec,
  apiKey: string,
  apiVersion: string,
  baseUrl?: string
): Record<string, ResourceConfig> {
  const endpoints = discoverListEndpoints(spec)
  const nestedEndpoints = discoverNestedEndpoints(spec, endpoints)
  const registry: Record<string, ResourceConfig> = {}
  const seenNested = new Set<string>()

  for (const [tableName, endpoint] of endpoints) {
    const isV2 = isV2Path(endpoint.apiPath)
    const children = nestedEndpoints
      .filter((n: NestedEndpoint) => n.parentTableName === tableName)
      .map((n: NestedEndpoint) => ({
        tableName: n.tableName,
        resourceId: n.resourceId,
        apiPath: n.apiPath,
        parentParamName: n.parentParamName,
        supportsPagination: n.supportsPagination,
      }))

    const rawListFn = buildListFn(apiKey, endpoint.apiPath, apiFetch, apiVersion, baseUrl)
    const rawRetrieveFn = buildRetrieveFn(apiKey, endpoint.apiPath, apiFetch, apiVersion, baseUrl)

    const config: ResourceConfig = {
      order: 1,
      tableName,
      supportsCreatedFilter: endpoint.supportsCreatedFilter,
      supportsLimit: endpoint.supportsLimit,
      supportsForwardPagination: isV2 || endpoint.supportsStartingAfter,
      sync: true,
      dependencies: [],
      listFn: buildSpecAwareListFn((params) => withHttpRetry(() => rawListFn(params), { label: `LIST ${endpoint.apiPath} (${tableName})` }), {
        isV2,
        supportsLimit: endpoint.supportsLimit,
        supportsStartingAfter: endpoint.supportsStartingAfter,
        supportsEndingBefore: endpoint.supportsEndingBefore,
        supportsCreatedFilter: endpoint.supportsCreatedFilter,
      }),
      retrieveFn: (id) => withHttpRetry(() => rawRetrieveFn(id), { label: `GET ${endpoint.apiPath}/${id} (${tableName})` }),
      nestedResources: children.length > 0 ? children : undefined,
    }
    registry[tableName] = config
  }

  for (const nested of nestedEndpoints) {
    if (!nested.parentTableName || registry[nested.tableName]) {
      continue
    }
    if (seenNested.has(nested.tableName)) {
      continue
    }
    seenNested.add(nested.tableName)

    const config: ResourceConfig = {
      order: 2,
      tableName: nested.tableName,
      supportsCreatedFilter: false,
      supportsLimit: nested.supportsPagination,
      supportsForwardPagination: nested.supportsPagination,
      sync: false,
      dependencies: [],
      listFn: undefined,
      retrieveFn: undefined,
      nestedResources: undefined,
      parentParamName: nested.parentParamName,
    }

    registry[nested.tableName] = config
  }

  return registry
}

export const STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES: Record<string, string> = {
  'checkout.session': 'checkout_sessions',
  'radar.early_fraud_warning': 'early_fraud_warnings',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'active_entitlements',
  subscription_schedule: 'subscription_schedules',
}

export function normalizeStripeObjectName(stripeObjectName: string): string {
  return resolveTableName(stripeObjectName, {
    ...OPENAPI_RESOURCE_TABLE_ALIASES,
    ...STRIPE_OBJECT_TO_SYNC_OBJECT_ALIASES,
  })
}

export const PREFIX_RESOURCE_MAP: Record<string, string> = {
  cus_: 'customers',
  gcus_: 'customers',
  in_: 'invoices',
  price_: 'prices',
  prod_: 'products',
  sub_: 'subscriptions',
  seti_: 'setup_intents',
  pm_: 'payment_methods',
  dp_: 'disputes',
  du_: 'disputes',
  ch_: 'charges',
  pi_: 'payment_intents',
  txi_: 'tax_ids',
  cn_: 'credit_notes',
  issfr_: 'early_fraud_warnings',
  prv_: 'reviews',
  re_: 'refunds',
  feat_: 'active_entitlements',
  cs_: 'checkout_sessions',
}

const SORTED_PREFIXES = Object.keys(PREFIX_RESOURCE_MAP).sort((a, b) => b.length - a.length)

export function getResourceFromPrefix(stripeId: string): string | undefined {
  const prefix = SORTED_PREFIXES.find((p) => stripeId.startsWith(p))
  return prefix ? PREFIX_RESOURCE_MAP[prefix] : undefined
}

export function getResourceConfigFromId(
  stripeId: string,
  registry: Record<string, ResourceConfig>
): ResourceConfig | undefined {
  const resourceName = getResourceFromPrefix(stripeId)
  return resourceName ? registry[resourceName] : undefined
}

export function getTableName(object: string, registry: Record<string, ResourceConfig>): string {
  const config = registry[object]
  if (!config) throw new Error(`No resource config found for object type: ${object}`)
  return config.tableName
}
