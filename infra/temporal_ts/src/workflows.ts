import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
} from '@temporalio/workflow'

import type { SyncActivities, SyncConfig, WorkflowStatus } from './types'

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

// Sync: 10m with retry and heartbeat
const { sync } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const pauseSignal = defineSignal('pause')
export const resumeSignal = defineSignal('resume')
export const updateConfigSignal = defineSignal<[Partial<SyncConfig>]>('update_config')
export const deleteSignal = defineSignal('delete')

// Query
export const statusQuery = defineQuery<WorkflowStatus>('status')

export async function syncWorkflow(config: SyncConfig): Promise<void> {
  let state: Record<string, unknown> = config.state ?? {}
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
  setHandler(updateConfigSignal, (newConfig: Partial<SyncConfig>) => {
    config = { ...config, ...newConfig }
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handler
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: 'running',
      paused,
      state,
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
      await continueAsNew<typeof syncWorkflow>({
        ...config,
        state,
        phase: 'running' as const,
      })
    }
  }

  // --- Setup (first run only) ---

  if (config.phase !== 'running') {
    await setup(config)
    if (deleted) {
      await teardown(config)
      return
    }
  }

  // --- Main loop: continuous reconciliation + optimistic updates ---

  while (true) {
    await waitWhilePaused()
    if (deleted) break

    // 1. Optimistic updates: drain buffered events (stateless — no cursors)
    if (eventBuffer.length > 0) {
      const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE)
      await sync(config, batch) // no state, fire-and-forget
      await tickIteration()
      continue // Re-check for more events before reconciliation
    }

    // 2. Reconciliation: next page (state carries pagination cursors forever)
    const result = await sync({ ...config, state })
    state = { ...state, ...result.state }
    await tickIteration()
  }

  // Teardown on delete
  await teardown(config)
}
