import Stripe from 'stripe'
import { ProcessNextResult, ResourceConfig, StripeSyncConfig } from './types'
import { RunKey } from './stripeSync'
import { toRecordMessage, type RecordMessage, type StateMessage } from '@stripe/sync-protocol'

export interface WorkerTaskManager {
  claimNextTask(
    accountId: string,
    runStartedAt: Date,
    rateLimit: number
  ): Promise<{
    object: string
    cursor: string | null
    pageCursor: string | null
    created_gte: number | null
    created_lte: number | null
  } | null>

  updateSyncObject(
    accountId: string,
    runStartedAt: Date,
    object: string,
    createdGte: number,
    createdLte: number,
    updates: {
      processedCount?: number
      cursor?: string | null
      status?: 'pending' | 'complete' | 'error'
      pageCursor?: string | null
      errorMessage?: string
    }
  ): Promise<number>

  releaseObjectSync(
    accountId: string,
    runStartedAt: Date,
    object: string,
    pageCursor: string,
    createdGte?: number,
    createdLte?: number
  ): Promise<void>
}

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
    private readonly taskManager: WorkerTaskManager,
    private readonly accountId: string,
    private readonly resourceRegistry: Record<string, ResourceConfig>,
    private readonly runKey: RunKey,
    private readonly upsertAny: (
      messages: RecordMessage[],
      accountId: string,
      backfillRelated?: boolean
    ) => Promise<unknown[] | void>,
    private readonly taskLimit: number = Infinity,
    private readonly rateLimit: number = 50,
    private readonly onStateMessage?: (msg: StateMessage) => void
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
        const isRateLimit = err instanceof Error && err.message.includes('Rate limit exceeded')
        if (isRateLimit) {
          const randomWait = Math.random() * 200 // 0 - 200ms random wait
          this.config.logger?.warn(
            `Rate limited on claimNextTask, backing off ${Math.round(randomWait)}ms`
          )
          await new Promise((r) => setTimeout(r, randomWait))
        } else {
          if (task) {
            await this.taskManager.updateSyncObject(
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
          this.config.logger?.error({ err }, 'Task processing failed; sleeping 1s before retry')
          await new Promise((r) => setTimeout(r, 1000))
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
    const response = await config.listFn(listParams)
    return response
  }

  async getNextTask(): Promise<SyncTask | null> {
    const { accountId, runStartedAt } = this.runKey

    // Atomically claim the next pending task (FOR UPDATE SKIP LOCKED).
    const claimed = await this.taskManager.claimNextTask(accountId, runStartedAt, this.rateLimit)
    if (!claimed) return null

    const object = claimed.object

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

    await this.taskManager.updateSyncObject(
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

    this.onStateMessage?.({
      type: 'state',
      stream: task.object,
      data: {
        cursor,
        pageCursor: complete ? null : lastId,
        status: complete ? 'complete' : 'pending',
        processedCount: data.length,
      },
    })
  }

  async processSingleTask(task: SyncTask): Promise<ProcessNextResult> {
    const config = this.getConfigForTaskObject(task.object)
    if (!config) throw new Error(`Unsupported object type for processSingleTask: ${task.object}`)

    const { data, has_more } = await this.fetchOnePage(
      task.object,
      task.cursor,
      task.pageCursor,
      config,
      task.created_gte,
      task.created_lte
    )
    if (data.length === 0 && has_more) {
      await this.taskManager.updateSyncObject(
        this.accountId,
        this.runKey.runStartedAt,
        task.object,
        task.created_gte,
        task.created_lte,
        { status: 'error', errorMessage: 'Stripe returned has_more=true with empty page' }
      )
    } else if (data.length > 0) {
      const records = this.toRecordMessages(task.object, data)
      await this.upsertAny(records, this.accountId, false)
    }

    await this.updateTaskProgress(task, data, has_more)
    return { hasMore: has_more, processed: data.length, runStartedAt: this.runKey.runStartedAt }
  }

  private toRecordMessages(tableName: string, data: unknown[]): RecordMessage[] {
    return data.map((item) => toRecordMessage(tableName, item as Record<string, unknown>))
  }

  private getConfigForTaskObject(taskObject: string): ResourceConfig | undefined {
    return Object.values(this.resourceRegistry).find((cfg) => cfg.tableName === taskObject)
  }
}
