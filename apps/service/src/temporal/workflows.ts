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
import { deepEqual, CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE, retryPolicy } from './types.js'
import type { WorkflowStatus } from './types.js'

// Setup/teardown: 2m with retry
const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Data activities: 10m with retry and heartbeat
const { sync, read, write } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const pauseSignal = defineSignal('pause')
export const resumeSignal = defineSignal('resume')
export const deleteSignal = defineSignal('delete')

// Query
export const statusQuery = defineQuery<WorkflowStatus>('status')

export async function pipelineWorkflow(
  pipelineId: string,
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
  let pendingWrites = opts?.pendingWrites ?? false

  // Register signal handlers (must be before any await)
  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(pauseSignal, () => {
    paused = true
  })
  setHandler(resumeSignal, () => {
    paused = false
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handler
  const phase = opts?.phase ?? 'setup'
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: phase === 'setup' && iteration > 0 ? 'running' : phase,
      paused,
      iteration,
    })
  )

  // --- Helpers ---

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
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

  if (phase !== 'running') {
    await setup(pipelineId)
    if (deleted) {
      await teardown(pipelineId)
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

        // Resolve events through read → Kafka
        if (inputQueue.length > 0) {
          const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
          const { count } = await read(pipelineId, { input: batch })
          if (count > 0) pendingWrites = true
          await tickIteration()
          continue
        }

        // Backfill one page → Kafka
        if (!readComplete) {
          const before = readState
          const { count, state: nextReadState } = await read(pipelineId, {
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
          const result = await write(pipelineId, { maxBatch: 50 })
          pendingWrites = result.written > 0
          writeState = { ...writeState, ...result.state }
          // Propagate writeState to syncState so continueAsNew carries the persisted truth
          syncState = writeState
          if (opts?.writeRps) await sleep(Math.ceil(1000 / opts.writeRps))
          await tickIteration()
        } else {
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

      // 1. Drain buffered events
      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        await sync(pipelineId, { input: batch })
        await tickIteration()
        continue
      }

      // 2. Reconciliation page
      if (!readComplete) {
        const before = syncState
        const result = await sync(pipelineId, { state: syncState, stateLimit: 1 })
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
  await teardown(pipelineId)
}
