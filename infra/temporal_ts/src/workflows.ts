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
  let phase: string = config.phase ?? 'setup'
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
      phase,
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
        phase: phase as SyncConfig['phase'],
      })
    }
  }

  // --- Setup phase ---

  async function runSetup() {
    await setup(config)
  }

  // --- Backfill phase ---

  async function runBackfill() {
    while (true) {
      await waitWhilePaused()
      if (deleted) return

      const result = await sync({ ...config, state })
      state = { ...state, ...result.state }

      await tickIteration()

      if (result.all_complete) break
      // Safety valve: no progress and no errors means nothing left to do
      if (result.state_count === 0 && result.errors.length === 0) break
    }
  }

  // --- Live phase ---

  async function runLive() {
    while (true) {
      await waitWhilePaused()
      if (deleted) return

      // Wait for events or 60s timeout
      await condition(() => eventBuffer.length > 0 || deleted, 60_000)

      if (deleted) return
      if (eventBuffer.length === 0) continue

      // Process batch
      const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE)
      const result = await sync({ ...config, state }, batch)
      state = { ...state, ...result.state }

      await tickIteration()
    }
  }

  // --- Phase state machine ---

  switch (phase) {
    case 'setup':
      await runSetup()
      if (deleted) {
        await teardown(config)
        return
      }
      phase = 'backfill'
      await runBackfill()
      if (deleted) {
        await teardown(config)
        return
      }
      phase = 'live'
      await runLive()
      if (deleted) {
        await teardown(config)
      }
      break
    case 'backfill':
      await runBackfill()
      if (deleted) {
        await teardown(config)
        return
      }
      phase = 'live'
      await runLive()
      if (deleted) {
        await teardown(config)
      }
      break
    case 'live':
      await runLive()
      if (deleted) {
        await teardown(config)
      }
      break
  }
}
