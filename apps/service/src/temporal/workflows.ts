import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
} from '@temporalio/workflow'

import type { SyncActivities, WorkflowStatus } from './types.js'

const CONTINUE_AS_NEW_THRESHOLD = 500
const EVENT_BATCH_SIZE = 50

const retryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2.0,
  maximumInterval: '5m',
  maximumAttempts: 10,
} as const

// Setup/teardown: 2m with retry
const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Run: 10m with retry and heartbeat
const { run } = proxyActivities<SyncActivities>({
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

export async function syncWorkflow(syncId: string, opts?: { phase?: string }): Promise<void> {
  let paused = false
  let deleted = false
  const eventBuffer: unknown[] = []
  let iteration = 0

  // Register signal handlers (must be before any await)
  setHandler(stripeEventSignal, (event: unknown) => {
    eventBuffer.push(event)
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
      await continueAsNew<typeof syncWorkflow>(syncId, { phase: 'running' })
    }
  }

  // --- Setup (first run only) ---

  if (phase !== 'running') {
    await setup(syncId)
    if (deleted) {
      await teardown(syncId)
      return
    }
  }

  // --- Main loop: continuous reconciliation + optimistic updates ---

  while (true) {
    await waitWhilePaused()
    if (deleted) break

    // 1. Drain buffered events
    if (eventBuffer.length > 0) {
      const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE)
      await run(syncId, batch)
      await tickIteration()
      continue // Re-check for more events before reconciliation
    }

    // 2. Reconciliation: backfill page (service manages state internally)
    await run(syncId)
    await tickIteration()
  }

  // Teardown on delete
  await teardown(syncId)
}
