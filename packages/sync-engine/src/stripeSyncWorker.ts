import Stripe from 'stripe'
import { PostgresClient } from './database/postgres'
import { ProcessNextResult, ResourceConfig, StripeSyncConfig } from './types'
import { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { RunKey } from './stripeSync'

export type SyncTask = {
  object: string
  cursor: string | null
  pageCursor: string | null
  created_gte: number
  created_lte: number
}

export class StripeSyncWorker {
  private running = false
  private loopPromise: Promise<void> | null = null
  private tasksCompleted = 0

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripeSyncConfig,
    private readonly sigma: SigmaSyncProcessor,
    private readonly postgresClient: PostgresClient,
    private readonly accountId: string,
    private readonly resourceRegistry: Record<string, ResourceConfig>,
    private readonly sigmaRegistry: Record<string, ResourceConfig>,
    private readonly runKey: RunKey,
    private readonly upsertAny: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      items: { [Key: string]: any }[],
      accountId: string,
      backfillRelated?: boolean
    ) => Promise<unknown[] | void>,
    private readonly taskLimit: number = Infinity,
    private readonly rateLimit: number = 50
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.loopPromise = this.loop()
  }

  async shutdown(): Promise<void> {
    this.running = false
    await this.loopPromise
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (this.tasksCompleted >= this.taskLimit) {
        this.running = false
        break
      }

      let task: SyncTask | null = null
      try {
        task = await this.getNextTask()
        if (!task) {
          this.running = false
          break
        }
        await this.processSingleTask(task)
        this.tasksCompleted++
      } catch (err) {
        if (task) {
          await this.postgresClient.updateSyncObject(
            this.accountId,
            this.runKey.runStartedAt,
            task.object,
            task.created_gte,
            task.created_lte,
            {
              status: 'error',
              errorMessage: `Task processing failed: ${String(err)}`,
            }
          )
        }
        const errStr = String(err).toLowerCase()
        if (errStr.includes('expired')) {
          // wait out the key rotation edge case
          this.config.logger?.error(
            { err },
            'Task processing failed (expired); sleeping 60s before retry'
          )
          await new Promise((r) => setTimeout(r, 60_000))
        } else {
          this.config.logger?.error({ err }, 'Task processing failed; sleeping 100ms before retry')
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    }
  }

  async waitUntilDone(): Promise<void> {
    await this.loopPromise
  }

  async fetchOnePage(
    object: string,
    cursor: string | null,
    pageCursor: string | null,
    config: ResourceConfig,
    created_gte?: number | null,
    created_lte?: number | null
  ) {
    if (config.sigma)
      throw new Error(`Sigma sync not supported in worker (config: ${JSON.stringify(config)})`)
    const listParams: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam } = {
      limit: 100,
    }
    if (config.supportsCreatedFilter) {
      const lte = cursor ? Number.parseInt(cursor, 10) : created_lte
      const createdFilter: Stripe.RangeQueryParam = {}
      if (lte != null && lte > 0) createdFilter.lte = lte
      if (created_gte && created_gte > 0) createdFilter.gte = created_gte
      if (Object.keys(createdFilter).length > 0) {
        listParams.created = createdFilter
      }
    }

    // Add pagination cursor (object ID) if present
    if (pageCursor) {
      listParams.starting_after = pageCursor
    }

    // Fetch from Stripe
    await this.postgresClient.waitForRateLimit(this.rateLimit)
    const response = await config.listFn(listParams)
    return response
  }

  async getNextTask(): Promise<SyncTask | null> {
    const { accountId, runStartedAt } = this.runKey

    // Atomically claim the next pending task (FOR UPDATE SKIP LOCKED).
    const claimed = await this.postgresClient.claimNextTask(accountId, runStartedAt)
    if (!claimed) return null

    const object = claimed.object

    const config = this.getConfigForTaskObject(object)
    if (config?.sigma) {
      return {
        object,
        cursor: claimed.cursor,
        pageCursor: claimed.pageCursor,
        created_gte: 0,
        created_lte: 0,
      }
    }

    return {
      object,
      cursor: claimed.cursor,
      pageCursor: claimed.pageCursor,
      created_gte: claimed.created_gte ?? 0,
      created_lte: claimed.created_lte ?? 0,
    }
  }

  async updateTaskProgress(
    task: SyncTask,
    data: Stripe.Response<Stripe.ApiList<unknown>>['data'],
    has_more: boolean
  ) {
    const minCreate = Math.min(...data.map((i) => (i as { created?: number }).created || 0))
    const cursor = minCreate > 0 ? String(minCreate) : null

    const lastItemCreated =
      data.length > 0
        ? Math.min(...data.map((i) => (i as { created?: number }).created ?? Infinity))
        : 0
    const pastBoundary =
      task.created_gte > 0 && lastItemCreated > 0 && lastItemCreated < task.created_gte
    const complete = !has_more || pastBoundary
    const lastId =
      has_more && data.length > 0 ? (data[data.length - 1] as { id: string }).id : undefined

    await this.postgresClient.updateSyncObject(
      this.accountId,
      this.runKey.runStartedAt,
      task.object,
      task.created_gte,
      task.created_lte,
      {
        processedCount: data.length,
        cursor,
        status: complete ? 'complete' : 'pending',
        pageCursor: complete ? null : lastId,
      }
    )
  }

  async processSingleTask(task: SyncTask): Promise<ProcessNextResult> {
    const config = this.getConfigForTaskObject(task.object)
    if (!config) throw new Error(`Unsupported object type for processSingleTask: ${task.object}`)

    // Sigma resources are processed via the SigmaSyncProcessor
    if (config.sigma) {
      if (!this.config.enableSigma) {
        throw new Error(`Sigma sync is disabled. Enable sigma to sync ${task.object}.`)
      }

      const result = await this.sigma.fetchOneSigmaPage(
        this.accountId,
        task.object,
        this.runKey.runStartedAt,
        task.cursor,
        config.sigma
      )

      // fetchOneSigmaPage handles progress, cursor advancement, and completion internally.
      // If there are more pages, release the task back to pending for re-claiming.
      if (result.hasMore) {
        await this.postgresClient.releaseObjectSync(
          this.accountId,
          this.runKey.runStartedAt,
          task.object,
          task.cursor ?? ''
        )
      }

      return result
    }

    // Core Stripe API resources
    const { data, has_more } = await this.fetchOnePage(
      task.object,
      task.cursor,
      task.pageCursor,
      config,
      task.created_gte,
      task.created_lte
    )
    if (data.length === 0 && has_more) {
      await this.postgresClient.updateSyncObject(
        this.accountId,
        this.runKey.runStartedAt,
        task.object,
        task.created_gte,
        task.created_lte,
        { status: 'error', errorMessage: 'Stripe returned has_more=true with empty page' }
      )
    } else if (data.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await this.upsertAny(data as { [Key: string]: any }[], this.accountId, false)
    }

    await this.updateTaskProgress(task, data, has_more)
    return { hasMore: has_more, processed: data.length, runStartedAt: this.runKey.runStartedAt }
  }

  private getConfigForTaskObject(taskObject: string): ResourceConfig | undefined {
    const coreMatch = Object.values(this.resourceRegistry).find(
      (cfg) => cfg.tableName === taskObject
    )
    if (coreMatch) return coreMatch

    return Object.values(this.sigmaRegistry).find((cfg) => cfg.tableName === taskObject)
  }
}
