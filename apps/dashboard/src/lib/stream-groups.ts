/** A discovered stream from the catalog. */
export interface CatalogStream {
  name: string
  primary_key: string[][]
  json_schema?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/** A group of related streams for the UI. */
export interface StreamGroup {
  name: string
  streams: CatalogStream[]
}

/**
 * Group streams by inferring categories from their names.
 *
 * Uses prefix heuristics — not a hardcoded mapping. Streams sharing a
 * common prefix word (e.g. "payment_intents", "payment_methods" → "Payment")
 * are grouped together. Single-word names become their own group.
 *
 * The algorithm:
 * 1. For each stream, extract the first word (before `_` or `.`)
 * 2. Capitalize it as the group name
 * 3. Group streams sharing the same first word
 * 4. Sort groups alphabetically, streams within groups alphabetically
 */
export function groupStreams(streams: CatalogStream[]): StreamGroup[] {
  const groups = new Map<string, CatalogStream[]>()

  for (const stream of streams) {
    const groupName = inferGroupName(stream.name)
    const group = groups.get(groupName) ?? []
    group.push(stream)
    groups.set(groupName, group)
  }

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, streams]) => ({
      name,
      streams: streams.sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

/** Infer a human-readable group name from a stream name. */
export function inferGroupName(streamName: string): string {
  // Handle dotted names (v2.core.account → "Core")
  if (streamName.includes('.')) {
    const parts = streamName.split('.')
    // Skip version prefix (v2.core.account → "Core")
    const meaningful = parts.find((p) => !p.match(/^v\d+$/))
    return capitalize(meaningful ?? parts[0])
  }

  // Handle snake_case names — use first word as group
  const firstWord = streamName.split('_')[0]

  // Map known prefixes to Stripe product groups (both singular and plural forms)
  const REFINEMENTS: Record<string, string> = {
    subscription: 'Billing',
    subscriptions: 'Billing',
    invoice: 'Billing',
    invoices: 'Billing',
    credit: 'Billing',
    price: 'Billing',
    prices: 'Billing',
    plan: 'Billing',
    plans: 'Billing',
    coupon: 'Billing',
    coupons: 'Billing',
    payment: 'Payments',
    charge: 'Payments',
    charges: 'Payments',
    refund: 'Payments',
    refunds: 'Payments',
    dispute: 'Payments',
    disputes: 'Payments',
    setup: 'Payments',
    checkout: 'Checkout',
    customer: 'Customers',
    customers: 'Customers',
    tax: 'Tax',
    product: 'Products',
    products: 'Products',
    transfer: 'Transfers',
    transfers: 'Transfers',
    payout: 'Payments',
    payouts: 'Payments',
    balance: 'Transfers',
    application: 'Connect',
    account: 'Connect',
    accounts: 'Connect',
    issuing: 'Issuing',
    treasury: 'Treasury',
    radar: 'Radar',
    early: 'Radar',
    file: 'Files',
    files: 'Files',
    event: 'Events',
    events: 'Events',
    webhook: 'Webhooks',
    webhooks: 'Webhooks',
  }

  return REFINEMENTS[firstWord] ?? capitalize(firstWord)
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Filter streams by search query (matches stream name, case-insensitive). */
export function filterStreams(streams: CatalogStream[], query: string): CatalogStream[] {
  if (!query.trim()) return streams
  const q = query.toLowerCase()
  return streams.filter((s) => s.name.toLowerCase().includes(q))
}
