import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  sleep,
} from '@temporalio/workflow'

import type { SyncActivities } from './activities.js'

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}
import {
  deepEqual,
  CONTINUE_AS_NEW_THRESHOLD,
  EVENT_BATCH_SIZE,
  retryPolicy,
} from '../lib/utils.js'

// Setup/teardown: 2m with retry
const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Data activities: 10m with retry and heartbeat
const { syncImmediate, readIntoQueue, writeFromQueue } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

// Pipeline type (matches lib/schemas.ts — keep in sync)
type SyncMode = 'incremental' | 'full_refresh'

interface StreamDef {
  name: string
  sync_mode?: SyncMode
  fields?: string[]
}

interface Pipeline {
  id: string
  source: { type: string; [key: string]: unknown }
  destination: { type: string; [key: string]: unknown }
  streams?: StreamDef[]
}

type PipelineConfig = {
  source: { type: string; [key: string]: unknown }
  destination: { type: string; [key: string]: unknown }
  streams?: StreamDef[]
}

function toConfig(pipeline: Pipeline): PipelineConfig {
  return {
    source: pipeline.source,
    destination: pipeline.destination,
    streams: pipeline.streams,
  }
}

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const updateSignal = defineSignal<[Partial<Pipeline>]>('update')
export const deleteSignal = defineSignal('delete')

// Queries
export const statusQuery = defineQuery<WorkflowStatus>('status')
export const configQuery = defineQuery<Pipeline>('config')
export const stateQuery = defineQuery<Record<string, unknown>>('state')

export async function pipelineWorkflow(
  pipeline: Pipeline,
  opts?: {
    phase?: string
    state?: Record<string, unknown>
    mode?: 'sync' | 'read-write'
    writeRps?: number
    pendingWrites?: boolean
    inputQueue?: unknown[]
  }
): Promise<void> {
  let paused = false
  let deleted = false
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let readComplete = false
  // pendingWrites is a coordination hint from the read loop to the write loop.
  // It avoids the write loop spinning on Kafka when the queue is known to be empty —
  // each writeFromQueue call creates a new consumer, joins the group, and waits 2s
  // for messages before returning. Without this gate the write loop would burn one
  // 2s activity invocation per tick just to learn "nothing to do."
  // The flag is best-effort: write self-corrects if it drifts (returns
  // written:0 when the queue is actually empty, written:>0 when it's not).
  let pendingWrites = opts?.pendingWrites ?? false

  // Register signal handlers (must be before any await)
  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(updateSignal, (patch: Partial<Pipeline>) => {
    if (patch.source) pipeline = { ...pipeline, source: patch.source }
    if (patch.destination) pipeline = { ...pipeline, destination: patch.destination }
    if (patch.streams !== undefined) pipeline = { ...pipeline, streams: patch.streams }
    if ('paused' in (patch as Record<string, unknown>)) {
      paused = !!(patch as Record<string, unknown>).paused
    }
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handlers
  const phase = opts?.phase ?? 'setup'
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: phase === 'setup' && iteration > 0 ? 'running' : phase,
      paused,
      iteration,
    })
  )
  setHandler(configQuery, (): Pipeline => pipeline)
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  // --- Helpers ---

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipeline, {
        phase: 'running',
        state: syncState,
        mode: opts?.mode,
        writeRps: opts?.writeRps,
        pendingWrites,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  // --- Setup (first sync only) ---

  const config = toConfig(pipeline)

  if (phase !== 'running') {
    const setupResult = await setup(config)
    // Merge setup-provisioned fields (webhook_secret, account_id, spreadsheet_id, etc.)
    if (setupResult.source) {
      pipeline = { ...pipeline, source: { ...pipeline.source, ...setupResult.source } }
    }
    if (setupResult.destination) {
      pipeline = {
        ...pipeline,
        destination: { ...pipeline.destination, ...setupResult.destination },
      }
    }
    if (deleted) {
      await teardown(toConfig(pipeline))
      return
    }
  }

  // --- Main loop ---

  if (opts?.mode === 'read-write') {
    // Concurrent read/write via Kafka queue — each loop runs at its own pace
    // writeState: persisted pipeline state, only advanced after successful writes (source of truth)
    // readState: pagination cursor for source reads, starts from writeState
    let writeState: Record<string, unknown> = { ...syncState }
    let readState: Record<string, unknown> = { ...writeState }

    async function readLoop(): Promise<void> {
      while (!deleted) {
        await waitWhilePaused()
        if (deleted) break

        const config = toConfig(pipeline)

        // Resolve events through read → Kafka
        if (inputQueue.length > 0) {
          const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
          const { count } = await readIntoQueue(config, pipeline.id, { input: batch })
          if (count > 0) pendingWrites = true
          await tickIteration()
          continue
        }

        // Backfill one page → Kafka
        if (!readComplete) {
          const before = readState
          const { count, state: nextReadState } = await readIntoQueue(config, pipeline.id, {
            state: readState,
            stateLimit: 1,
          })
          if (count > 0) pendingWrites = true
          readState = { ...readState, ...nextReadState }
          readComplete = deepEqual(readState, before)
          await tickIteration()
          continue
        }

        // All caught up — wait for new events or delete
        await condition(() => inputQueue.length > 0 || deleted)
      }
    }

    async function writeLoop(): Promise<void> {
      while (!deleted) {
        await waitWhilePaused()
        if (deleted) break

        if (pendingWrites) {
          const config = toConfig(pipeline)
          const result = await writeFromQueue(config, pipeline.id, { maxBatch: 50 })
          pendingWrites = result.written > 0
          writeState = { ...writeState, ...result.state }
          syncState = writeState
          if (opts?.writeRps) await sleep(Math.ceil(1000 / opts.writeRps))
          await tickIteration()
        } else {
          // Wait until the read loop signals there's work, or we're deleted
          await condition(() => pendingWrites || deleted)
        }
      }
    }

    await Promise.all([readLoop(), writeLoop()])
  } else {
    // sync mode: combined read+write in a single activity call

    while (true) {
      await waitWhilePaused()
      if (deleted) break

      const config = toConfig(pipeline)

      // 1. Drain buffered events
      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        await syncImmediate(config, { input: batch })
        await tickIteration()
        continue
      }

      // 2. Reconciliation page
      if (!readComplete) {
        const before = syncState
        const result = await syncImmediate(config, { state: syncState, stateLimit: 1 })
        syncState = { ...syncState, ...result.state }
        readComplete = deepEqual(syncState, before)
        await tickIteration()
        continue
      }

      // 3. Wait
      await condition(() => inputQueue.length > 0 || deleted)
    }
  }

  // Teardown on delete
  await teardown(toConfig(pipeline))
}
