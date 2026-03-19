import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import { VERSION } from './version'
import { PostgresClient } from './database/postgres'
import type { DestinationWriter } from '@stripe/destination-postgres'
import type { StripeSyncConfig, SyncResult, SyncObject, ResourceConfig, Logger } from './types'
import { type PoolConfig } from 'pg'
import {
  hashApiKey,
  StripeSyncWebhook,
  buildResourceRegistry,
  getResourceConfigFromId,
  getTableName,
  normalizeStripeObjectName,
  StripeSyncWorker,
  backfillDependencies,
  expandLists,
  syncSubscriptionItems,
  upsertSubscriptionItems,
  type WorkerTaskManager,
  type StripeObject,
  type ResourceConfig as SourceResourceConfig,
} from '@stripe/source-stripe'
import { fromRecordMessage, type RecordMessage } from '@stripe/sync-protocol'

/**
 * Identifies a specific sync run.
 */
export type RunKey = {
  accountId: string
  runStartedAt: Date
}

function buildPoolConfig(config: StripeSyncConfig): PoolConfig {
  const poolConfig = config.poolConfig ?? ({} as PoolConfig)
  if (config.databaseUrl) poolConfig.connectionString = config.databaseUrl
  if (config.maxPostgresConnections) poolConfig.max = config.maxPostgresConnections
  poolConfig.max ??= 10
  poolConfig.keepAlive ??= true
  return poolConfig
}

function buildProgressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

export class StripeSync {
  stripe: Stripe
  postgresClient: PostgresClient
  config: StripeSyncConfig
  readonly resourceRegistry: Record<StripeObject, ResourceConfig>
  webhook!: StripeSyncWebhook
  accountId!: string
  private savedLogger: Logger | null = null
  private previousLineCount = 0

  private get dataSchemaName(): string {
    return this.config.schemaName ?? 'stripe'
  }

  private get syncMetadataSchemaName(): string {
    return this.config.syncTablesSchemaName ?? this.dataSchemaName
  }

  private quoteSyncMetadataSchemaName(): string {
    return `"${this.syncMetadataSchemaName.replaceAll('"', '""')}"`
  }

  private disableLogger() {
    this.savedLogger = this.config.logger ?? null
    this.config.logger = { info() {}, warn() {}, error() {} }
  }

  private enableLogger() {
    if (this.savedLogger) {
      this.config.logger = this.savedLogger
      this.savedLogger = null
    }
  }

  private constructor(config: StripeSyncConfig) {
    this.config = config
    this.stripe = new Stripe(config.stripeSecretKey, {
      // https://github.com/stripe/stripe-node#configuration
      // @ts-ignore
      apiVersion: config.stripeApiVersion,
      telemetry: false,
      maxNetworkRetries: 3,
      appInfo: {
        name: 'Stripe Sync Engine',
        version: VERSION,
        url: 'https://github.com/stripe/sync-engine',
        ...(config.partnerId ? { partner_id: config.partnerId } : {}),
      },
    })

    this.config.logger = config.logger ?? console
    this.config.logger?.info(
      { autoExpandLists: config.autoExpandLists, stripeApiVersion: config.stripeApiVersion },
      'StripeSync initialized'
    )

    const poolConfig = buildPoolConfig(config)

    this.postgresClient = new PostgresClient({
      schema: this.dataSchemaName,
      syncSchema: this.syncMetadataSchemaName,
      poolConfig,
    })

    this.resourceRegistry = buildResourceRegistry(this.stripe)
  }

  /**
   * Create a new StripeSync instance. Resolves the default Stripe account,
   * stores it in the database, and makes the account ID available immediately.
   */
  static async create(config: StripeSyncConfig): Promise<StripeSync> {
    const instance = new StripeSync(config)
    if (config.stripeAccountId) {
      instance.accountId = config.stripeAccountId
      const apiKeyHash = hashApiKey(config.stripeSecretKey)
      await instance.postgresClient.upsertAccount(
        { id: config.stripeAccountId, raw_data: { id: config.stripeAccountId } },
        apiKeyHash
      )
    } else {
      const account = await instance.getCurrentAccount()
      instance.accountId = account.id
    }
    const pg = instance.postgresClient
    const writer: DestinationWriter = {
      upsertManyWithTimestampProtection: (entries, table, accountId, syncTimestamp) =>
        pg.upsertManyWithTimestampProtection(entries, table, accountId, syncTimestamp),
      delete: (table, id) => pg.delete(table, id),
      columnExists: (table, column) => pg.columnExists(table, column),
      deleteRemovedActiveEntitlements: (customerId, currentIds) =>
        pg.deleteRemovedActiveEntitlements(customerId, currentIds),
      query: (text, params) => pg.query(text, params),
      withAdvisoryLock: (key, fn) => pg.withAdvisoryLock(key, fn),
    }
    instance.webhook = new StripeSyncWebhook({
      stripe: instance.stripe,
      writer,
      config: instance.config,
      accountId: instance.accountId,
      getAccountId: instance.getAccountId.bind(instance),
      upsertAny: instance.upsertRecordMessages.bind(instance),
      resourceRegistry: instance.resourceRegistry,
    })
    return instance
  }

  async getAccountId(objectAccountId?: string): Promise<string> {
    if (!objectAccountId) {
      return this.accountId
    }
    const account = await this.getCurrentAccount(objectAccountId)
    return account.id
  }

  async getCurrentAccount(objectAccountId?: string): Promise<Stripe.Account> {
    const apiKeyHash = hashApiKey(this.config.stripeSecretKey)

    try {
      const account = await this.postgresClient.getAccountByApiKeyHash(apiKeyHash)
      if (account) {
        return account as Stripe.Account
      }
    } catch (error) {
      this.config.logger?.warn(
        error,
        'Failed to lookup account by API key hash, falling back to API'
      )
    }

    try {
      const accountIdParam = objectAccountId || this.config.stripeAccountId
      const account = accountIdParam
        ? await this.stripe.accounts.retrieve(accountIdParam)
        : await this.stripe.accounts.retrieve()

      await this.postgresClient.upsertAccount({ id: account.id, raw_data: account }, apiKeyHash)
      return account
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve account from Stripe API')
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
      throw new Error(`Failed to retrieve Stripe account: ${message}`)
    }
  }

  public getSupportedSyncObjects(): Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] {
    return Object.entries(this.resourceRegistry)
      .filter(([, cfg]) => cfg.sync !== false)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key) as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]
  }

  async syncSingleEntity(stripeId: string) {
    const accountId = this.accountId
    const resourceConfig = getResourceConfigFromId(stripeId, this.resourceRegistry)
    if (!resourceConfig || !resourceConfig.retrieveFn) {
      throw new Error(`Unsupported object type for syncSingleEntity: ${stripeId}`)
    }
    const item = await resourceConfig.retrieveFn(stripeId)
    await this.upsertAny([item], accountId, false)
  }

  private getRegistryForObject(_object: string): Record<string, ResourceConfig> {
    return this.resourceRegistry
  }

  async findOldestItem(listfn: NonNullable<ResourceConfig['listFn']>) {
    let lo = 0
    let hi = Math.floor(Date.now() / 1000)
    let best: number | null = null

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)

      const page = await listfn({
        limit: 1,
        created: { lte: mid },
      })

      if (page.data.length > 0) {
        best = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }

    return best
  }

  async createChunks(
    objects: StripeObject[],
    workerCount: number = 100
  ): Promise<{
    chunkCursors: Record<string, number[]>
    nonChunkTables: string[]
    failedObjects: Array<{ tableName: string; error: string }>
  }> {
    const failedObjects: Array<{ tableName: string; error: string }> = []
    const failedObjectKeys = new Set<StripeObject>()

    const cursors = await Promise.all(
      objects
        .filter((obj) => this.resourceRegistry[obj]?.supportsCreatedFilter)
        .map(async (obj) => {
          const config = this.resourceRegistry[obj]
          if (!config.listFn) return null
          try {
            const oldest = await this.findOldestItem(config.listFn)
            if (oldest === null) return null
            return { object: obj, oldest }
          } catch (err) {
            const tableName = getTableName(obj, this.getRegistryForObject(obj))
            this.config.logger?.warn(
              { err, object: obj },
              'Failed to probe oldest item for object during initialization; marking as errored'
            )
            failedObjectKeys.add(obj)
            failedObjects.push({ tableName, error: String(err) })
            return null
          }
        })
    )

    const chunkCount = 2 * workerCount
    const validCursors = cursors.filter(
      (c): c is { object: StripeObject; oldest: number } => c !== null
    )
    const chunkCursors: Record<string, number[]> = {}
    const nonChunkCursors = objects.filter(
      (obj) => !validCursors.some((c) => c.object === obj) && !failedObjectKeys.has(obj)
    )
    const nonChunkTables = nonChunkCursors.map((obj) =>
      getTableName(obj, this.getRegistryForObject(obj))
    )
    const now = Math.floor(Date.now() / 1000)
    for (const { object: obj, oldest } of validCursors) {
      const tableName = getTableName(obj, this.getRegistryForObject(obj))
      const range = now - oldest
      const interval = Math.max(Math.floor(range / chunkCount), 3600)
      const timestamps: number[] = []
      let ts = oldest
      while (ts < now) {
        timestamps.push(ts)
        ts += interval
      }

      chunkCursors[tableName] = timestamps
    }

    return { chunkCursors, nonChunkTables, failedObjects }
  }

  private buildPriorityMap(objects: StripeObject[]): Record<string, number> {
    const priorities: Record<string, number> = {}
    for (const obj of objects) {
      const config = this.getRegistryForObject(obj)[obj]
      if (config) {
        priorities[config.tableName] = config.order
      }
    }
    return priorities
  }

  async initializeSegment(
    runKey: RunKey,
    objects: StripeObject[],
    workerCount: number
  ): Promise<RunKey> {
    const { chunkCursors, nonChunkTables, failedObjects } = await this.createChunks(
      objects,
      workerCount
    )
    const priorities = this.buildPriorityMap(objects)
    await this.postgresClient.createChunkedObjectRuns(
      runKey.accountId,
      runKey.runStartedAt,
      chunkCursors,
      priorities
    )
    if (nonChunkTables.length > 0) {
      await this.postgresClient.createObjectRuns(
        runKey.accountId,
        runKey.runStartedAt,
        nonChunkTables,
        priorities
      )
    }
    for (const { tableName, error } of failedObjects) {
      await this.postgresClient.createObjectRuns(
        runKey.accountId,
        runKey.runStartedAt,
        [tableName],
        priorities
      )
      await this.postgresClient.failObjectSync(
        runKey.accountId,
        runKey.runStartedAt,
        tableName,
        `Initialization failed: ${error}`
      )
    }
    return runKey
  }

  async reconciliationSync(
    objects: StripeObject[],
    tableNames: string[],
    segmentedSync: boolean,
    triggeredBy: string = 'fullSync',
    interval?: number,
    workerCount: number = 100
  ): Promise<RunKey | null> {
    const priorities = this.buildPriorityMap(objects)
    const runKey = await this.postgresClient.reconciliationRun(
      this.accountId,
      triggeredBy,
      tableNames,
      interval,
      priorities,
      segmentedSync
    )
    if (runKey == null) {
      return null
    }
    if (segmentedSync) {
      const existingCount = await this.postgresClient.countObjectRuns(
        runKey.accountId,
        runKey.runStartedAt
      )
      if (existingCount === 0) {
        await this.initializeSegment(runKey, objects, workerCount)
      } else {
        this.config.logger?.info(
          { existingCount },
          `Skipping segment initialization — ${existingCount} object run(s) already exist`
        )
      }
    }
    return runKey
  }

  async fullSync(
    tables?: StripeObject[],
    segmentedSync: boolean = true,
    workerCount: number = 20,
    rateLimit: number = 10,
    monitorProgress: boolean = true,
    interval?: number
  ): Promise<{
    results: Record<string, SyncResult>
    totals: Record<string, number>
    totalSynced: number
    skipped: string[]
    errors: Array<{ object: string; message: string }>
  }> {
    const objects = tables && tables.length > 0 ? tables : this.getSupportedSyncObjects()
    const tableNames = objects.map((obj) => getTableName(obj, this.getRegistryForObject(obj)))
    const runKey = await this.reconciliationSync(
      objects,
      tableNames,
      segmentedSync,
      'fullSync',
      interval,
      workerCount
    )
    if (runKey == null) {
      return { results: {}, totals: {}, totalSynced: 0, skipped: [], errors: [] }
    }

    const resetCount = await this.postgresClient.resetStuckRunningObjects(
      runKey.accountId,
      runKey.runStartedAt
    )
    if (resetCount > 0) {
      this.config.logger?.info(
        { resetCount },
        `Reset ${resetCount} stuck 'running' object(s) to 'pending' (crash recovery)`
      )
    }

    const taskManager: WorkerTaskManager = {
      claimNextTask: (accountId, runStartedAt, rl) =>
        this.postgresClient.claimNextTask(accountId, runStartedAt, rl),
      updateSyncObject: (accountId, runStartedAt, object, createdGte, createdLte, updates) =>
        this.postgresClient.updateSyncObject(
          accountId,
          runStartedAt,
          object,
          createdGte,
          createdLte,
          updates
        ),
      releaseObjectSync: (accountId, runStartedAt, object, pageCursor, createdGte, createdLte) =>
        this.postgresClient.releaseObjectSync(
          accountId,
          runStartedAt,
          object,
          pageCursor,
          createdGte,
          createdLte
        ),
    }

    const workers = Array.from(
      { length: workerCount },
      () =>
        new StripeSyncWorker(
          this.stripe,
          this.config,
          taskManager,
          this.accountId,
          this.resourceRegistry,
          runKey,
          this.upsertRecordMessages.bind(this),
          Infinity,
          rateLimit
        )
    )
    workers.forEach((worker) => worker.start())

    let monitorInterval: ReturnType<typeof setInterval> | undefined
    if (monitorProgress) {
      this.disableLogger()
      monitorInterval = this.startTableMonitor(1000, runKey)
    }

    await Promise.all(workers.map((worker) => worker.waitUntilDone()))
    clearInterval(monitorInterval)
    this.enableLogger()
    await this.printProgress(runKey)

    const totals = await this.postgresClient.getObjectSyncedCounts(
      this.accountId,
      runKey.runStartedAt
    )

    const results: Record<string, SyncResult> = {}
    const errors: Array<{ object: string; message: string }> = []
    for (const [obj, count] of Object.entries(totals)) {
      results[obj] = { synced: count }
    }
    const totalSynced = Object.values(totals).reduce((sum, count) => sum + count, 0)

    await this.postgresClient.closeSyncRun(runKey.accountId, runKey.runStartedAt)

    return { results, totals, totalSynced, skipped: [], errors }
  }

  private async upsertRecordMessages(
    messages: RecordMessage[],
    accountId: string,
    backfillRelated?: boolean,
    syncTimestamp?: string
  ): Promise<unknown[] | void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items = messages.map(fromRecordMessage) as { [Key: string]: any }[]
    return this.upsertAny(items, accountId, backfillRelated, syncTimestamp)
  }

  async upsertAny(
    items: { [Key: string]: any }[], // eslint-disable-line @typescript-eslint/no-explicit-any
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<unknown[]> {
    if (items.length === 0) return []
    const stripeObjectName = items[0].object

    const syncObjectName = normalizeStripeObjectName(stripeObjectName)
    const registry = this.getRegistryForObject(syncObjectName)
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await backfillDependencies({
        items,
        syncObjectName,
        accountId,
        syncTimestamp,
        registry: registry as Record<string, SourceResourceConfig>,
        backfillAny: (ids, objectName, acctId, ts) =>
          this.backfillAny(ids, objectName as StripeObject, acctId, ts),
      })
    }

    const config = registry[syncObjectName]
    const autoExpandLists = this.config.autoExpandLists ?? false
    if (autoExpandLists && config?.listExpands) {
      await expandLists({ items, listExpands: config.listExpands })
    }

    const tableName = getTableName(syncObjectName, registry)
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      items,
      tableName,
      accountId,
      syncTimestamp
    )

    if (syncObjectName === 'subscription') {
      await syncSubscriptionItems({
        subscriptions: items as Stripe.Subscription[],
        accountId,
        syncTimestamp,
        upsertItems: (subItems, acctId, ts) =>
          upsertSubscriptionItems(
            subItems,
            acctId,
            (entries, table, aid, sts) =>
              this.postgresClient.upsertManyWithTimestampProtection(entries, table, aid, sts),
            ts
          ),
        markDeleted: (subscriptionId, currentSubItemIds) =>
          this.markDeletedSubscriptionItems(subscriptionId, currentSubItemIds),
      })
    }

    return rows
  }

  async backfillAny(
    ids: string[],
    objectName: StripeObject,
    accountId: string,
    syncTimestamp?: string
  ) {
    const config = this.getRegistryForObject(objectName)[objectName]
    const tableName = config?.tableName ?? objectName
    if (!config?.retrieveFn) {
      throw new Error(`No retrieveFn registered for resource: ${objectName}`)
    }

    const missingIds = await this.postgresClient.findMissingEntries(tableName, ids)

    const items = await this.fetchMissingEntities(missingIds, (id) => config.retrieveFn!(id))
    return this.upsertAny(items, accountId, false, syncTimestamp)
  }

  async markDeletedSubscriptionItems(
    subscriptionId: string,
    currentSubItemIds: string[]
  ): Promise<{ rowCount: number }> {
    const schema = this.quoteSyncMetadataSchemaName()
    let prepared = sql(`
    select id from ${schema}."subscription_items"
    where subscription = :subscriptionId and COALESCE(deleted, false) = false;
    `)({ subscriptionId })
    const { rows } = await this.postgresClient.query(prepared.text, prepared.values)
    const deletedIds = rows.filter(
      ({ id }: { id: string }) => currentSubItemIds.includes(id) === false
    )

    if (deletedIds.length > 0) {
      const ids = deletedIds.map(({ id }: { id: string }) => id)
      prepared = sql(`
      update ${schema}."subscription_items"
      set _raw_data = jsonb_set(_raw_data, '{deleted}', 'true'::jsonb)
      where id=any(:ids::text[]);
      `)({ ids })
      const { rowCount } = await this.postgresClient.query(prepared.text, prepared.values)
      return { rowCount: rowCount || 0 }
    } else {
      return { rowCount: 0 }
    }
  }

  async upsertActiveEntitlements(
    customerId: string,
    activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) {
    const entitlements = activeEntitlements.map((entitlement) => ({
      id: entitlement.id,
      object: entitlement.object,
      feature:
        typeof entitlement.feature === 'string' ? entitlement.feature : entitlement.feature.id,
      customer: customerId,
      livemode: entitlement.livemode,
      lookup_key: entitlement.lookup_key,
    }))

    return this.upsertAny(entitlements, accountId, backfillRelatedEntities, syncTimestamp)
  }

  async fetchMissingEntities<T>(
    ids: string[],
    fetch: (id: string) => Promise<Stripe.Response<T>>
  ): Promise<T[]> {
    if (!ids.length) return []
    return Promise.all(ids.map(fetch))
  }

  async close(): Promise<void> {
    await this.postgresClient.pool.end()
  }

  async printProgress(runKey: RunKey): Promise<void> {
    const schema = this.quoteSyncMetadataSchemaName()
    const syncQuery = {
      text: `SELECT * FROM ${schema}."sync_obj_progress"
                  WHERE account_id = $1 AND run_started_at = $2
                  ORDER BY object`,
      values: [runKey.accountId, runKey.runStartedAt],
    }

    const [syncResult] = await Promise.all([
      this.postgresClient.query(syncQuery.text, syncQuery.values),
    ])

    const lines: string[] = []

    if (syncResult.rows.length > 0) {
      lines.push('')
      lines.push('--- Sync Progress ---')
      for (const row of syncResult.rows) {
        const pct = Number(row.pct_complete ?? 0)
        const bar = buildProgressBar(pct, 20)
        lines.push(
          `  ${row.object.padEnd(24)} ${bar} ${String(pct.toFixed(1)).padStart(5)}%  (${row.processed} rows)`
        )
      }
    }

    if (this.previousLineCount > 0) {
      process.stdout.write('\x1B[2K\x1B[0G')
      process.stdout.write('\x1B[1A\x1B[2K'.repeat(this.previousLineCount))
      process.stdout.write('\x1B[0G')
    }

    for (const line of lines) {
      console.log(line)
    }
    this.previousLineCount = lines.length
  }

  startTableMonitor(intervalMs = 2000, runKey: RunKey): ReturnType<typeof setInterval> {
    return setInterval(async () => {
      try {
        await this.printProgress(runKey)
      } catch {
        // ignore monitoring errors
      }
    }, intervalMs)
  }
}
