/**
 * Lightweight webhook service factory that replaces StripeSync for the Fastify server.
 * Creates the minimum components needed to handle incoming Stripe webhook events.
 */
import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import { PostgresDestinationWriter } from '@stripe/destination-postgres'
import type { DestinationWriter } from '@stripe/destination-postgres'
import { fromRecordMessage, type RecordMessage } from '@stripe/sync-protocol'
import { StripeSyncWebhook, type WebhookConfig } from '../stripeSyncWebhook'
import { buildResourceRegistry, normalizeStripeObjectName, getTableName } from '../resourceRegistry'
import type { ResourceConfig, Logger, RevalidateEntity } from '../types'
import { expandLists, syncSubscriptionItems, upsertSubscriptionItems } from '../transforms'
import { hashApiKey } from '../utils/hashApiKey'
import type { PoolConfig } from 'pg'
import pkg from '../../package.json' with { type: 'json' }

export interface WebhookServiceConfig {
  stripeSecretKey: string
  stripeWebhookSecret?: string
  databaseUrl: string
  stripeApiVersion?: string
  stripeAccountId?: string
  partnerId?: string
  schemaName?: string
  syncTablesSchemaName?: string
  autoExpandLists?: boolean
  backfillRelatedEntities?: boolean
  revalidateObjectsViaStripeApi?: Array<RevalidateEntity>
  logger?: Logger
  poolConfig?: PoolConfig
}

export interface WebhookService {
  webhook: StripeSyncWebhook
  accountId: string
  /** The underlying Stripe client (useful for mocking in tests). */
  stripe: Stripe
  /** The underlying destination writer (useful for raw queries in tests). */
  writer: PostgresDestinationWriter
  /** Convenience: upsert raw Stripe objects. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upsertAny(
    items: { [Key: string]: any }[],
    accountId: string,
    syncTimestamp?: string
  ): Promise<unknown[]>
  /** Convenience: upsert active entitlements for a customer. */
  upsertActiveEntitlements(
    customerId: string,
    activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
    accountId: string,
    syncTimestamp?: string
  ): Promise<unknown[]>
  /** Convenience: get the resolved account ID. */
  getAccountId(objectAccountId?: string): Promise<string>
  /** Convenience: raw SQL query via the writer pool. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>
  close(): Promise<void>
}

/**
 * Creates a webhook service — a lightweight alternative to StripeSync for webhook-only workloads.
 * Composes StripeSyncWebhook + PostgresDestinationWriter + ResourceRegistry directly.
 */
export async function createWebhookService(config: WebhookServiceConfig): Promise<WebhookService> {
  const dataSchema = config.schemaName ?? 'stripe'
  const syncSchema = config.syncTablesSchemaName ?? dataSchema
  const logger = config.logger ?? console

  // 1. Create Stripe client
  const stripe = new Stripe(config.stripeSecretKey, {
    // @ts-ignore
    apiVersion: config.stripeApiVersion ?? '2020-08-27',
    telemetry: false,
    maxNetworkRetries: 3,
    appInfo: {
      name: 'Stripe Sync Engine',
      version: pkg.version,
      url: 'https://github.com/stripe/sync-engine',
      ...(config.partnerId ? { partner_id: config.partnerId } : {}),
    },
  })

  // 2. Create destination writer (pool + queries)
  const poolConfig: PoolConfig = {
    max: 10,
    keepAlive: true,
    connectionString: config.databaseUrl,
    ...config.poolConfig,
  }
  const writer = new PostgresDestinationWriter({
    schema: dataSchema,
    syncSchema,
    poolConfig,
  })

  // 3. Resolve account ID
  let accountId: string
  if (config.stripeAccountId) {
    accountId = config.stripeAccountId
    // Store account record
    const apiKeyHash = hashApiKey(config.stripeSecretKey)
    const quotedSchema = `"${syncSchema.replaceAll('"', '""')}"`
    await writer.query(
      `INSERT INTO ${quotedSchema}."_sync_accounts" (id, api_key_hash, raw_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET api_key_hash = $2, raw_data = $3`,
      [accountId, apiKeyHash, JSON.stringify({ id: accountId })]
    )
  } else {
    const account = await stripe.accounts.retrieve()
    accountId = account.id
    const apiKeyHash = hashApiKey(config.stripeSecretKey)
    const quotedSchema = `"${syncSchema.replaceAll('"', '""')}"`
    await writer.query(
      `INSERT INTO ${quotedSchema}."_sync_accounts" (id, api_key_hash, raw_data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET api_key_hash = $2, raw_data = $3`,
      [accountId, apiKeyHash, JSON.stringify(account)]
    )
  }

  // 4. Build resource registry
  const resourceRegistry = buildResourceRegistry(stripe)

  // 5. Create upsertAny for webhook events
  const quotedSyncSchema = `"${syncSchema.replaceAll('"', '""')}"`
  const autoExpandLists = config.autoExpandLists ?? false

  async function upsertRecordMessages(
    messages: RecordMessage[],
    acctId: string,
    _backfillRelated?: boolean,
    syncTimestamp?: string
  ): Promise<unknown[] | void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = messages.map(fromRecordMessage) as { [Key: string]: any }[]
    return upsertAny(items, acctId, syncTimestamp)
  }

  async function upsertAny(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: { [Key: string]: any }[],
    acctId: string,
    syncTimestamp?: string
  ): Promise<unknown[]> {
    if (items.length === 0) return []

    const stripeObjectName = items[0].object
    const syncObjectName = normalizeStripeObjectName(stripeObjectName)
    const registry = resourceRegistry as Record<string, ResourceConfig>
    const objConfig = registry[syncObjectName]

    if (autoExpandLists && objConfig?.listExpands) {
      await expandLists({ items, listExpands: objConfig.listExpands })
    }

    const tableName = getTableName(syncObjectName, registry)
    const rows = await writer.upsertManyWithTimestampProtection(
      items,
      tableName,
      acctId,
      syncTimestamp
    )

    if (syncObjectName === 'subscription') {
      await syncSubscriptionItems({
        subscriptions: items as Stripe.Subscription[],
        accountId: acctId,
        syncTimestamp,
        upsertItems: (subItems, aid, ts) =>
          upsertSubscriptionItems(
            subItems,
            aid,
            (entries, table, a, sts) =>
              writer.upsertManyWithTimestampProtection(entries, table, a, sts),
            ts
          ),
        markDeleted: async (subscriptionId, currentSubItemIds) => {
          let prepared = sql(`
          select id from ${quotedSyncSchema}."subscription_items"
          where subscription = :subscriptionId and COALESCE(deleted, false) = false;
          `)({ subscriptionId })
          const { rows: existingRows } = await writer.query(prepared.text, prepared.values)
          const deletedIds = existingRows.filter(
            ({ id }: { id: string }) => !currentSubItemIds.includes(id)
          )
          if (deletedIds.length > 0) {
            const ids = deletedIds.map(({ id }: { id: string }) => id)
            prepared = sql(`
            update ${quotedSyncSchema}."subscription_items"
            set _raw_data = jsonb_set(_raw_data, '{deleted}', 'true'::jsonb)
            where id=any(:ids::text[]);
            `)({ ids })
            const { rowCount } = await writer.query(prepared.text, prepared.values)
            return { rowCount: rowCount || 0 }
          }
          return { rowCount: 0 }
        },
      })
    }

    return rows
  }

  // 6. Create webhook handler
  const webhookHandler = new StripeSyncWebhook({
    stripe,
    writer: writer as DestinationWriter,
    config: {
      stripeWebhookSecret: config.stripeWebhookSecret,
      schemaName: dataSchema,
      syncTablesSchemaName: syncSchema,
      logger,
      revalidateObjectsViaStripeApi: config.revalidateObjectsViaStripeApi,
    },
    accountId,
    getAccountId: async (objectAccountId?: string) => objectAccountId ?? accountId,
    upsertAny: upsertRecordMessages,
    resourceRegistry: resourceRegistry as Record<string, ResourceConfig>,
  })

  return {
    webhook: webhookHandler,
    accountId,
    stripe,
    writer,
    upsertAny,
    async upsertActiveEntitlements(
      customerId: string,
      activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
      acctId: string,
      syncTimestamp?: string
    ): Promise<unknown[]> {
      const entitlements = activeEntitlements.map((entitlement) => ({
        id: entitlement.id,
        object: entitlement.object,
        feature:
          typeof entitlement.feature === 'string' ? entitlement.feature : entitlement.feature.id,
        customer: customerId,
        livemode: entitlement.livemode,
        lookup_key: entitlement.lookup_key,
      }))
      return upsertAny(entitlements, acctId, syncTimestamp)
    },
    async getAccountId(objectAccountId?: string): Promise<string> {
      return objectAccountId ?? accountId
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(text: string, params?: any[]) {
      return writer.query(text, params)
    },
    async close() {
      await writer.pool.end()
    },
  }
}
