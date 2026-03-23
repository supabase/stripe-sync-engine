import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
} from '@temporalio/workflow'

import type {
  SyncActivities,
  SyncConfig,
  WorkflowStatus,
} from './types'

const CONTINUE_AS_NEW_THRESHOLD = 500
const EVENT_BATCH_SIZE = 50

const retryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2.0,
  maximumInterval: '5m',
  maximumAttempts: 10,
} as const

// Health check: 30s, no retry
const {healthCheck} = proxyActivities<SyncActivities>({
  startToCloseTimeout: '30s',
})

// Setup/teardown/process event: 2m with retry
const {
  sourceSetup,
  destinationSetup,
  processEvent,
  sourceTeardown,
  destinationTeardown,
} = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Data activities: 5m with retry and heartbeat
const {backfillPage, writeBatch} = proxyActivities<SyncActivities>({
  startToCloseTimeout: '5m',
  heartbeatTimeout: '1m',
  retry: retryPolicy,
})

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const pauseSignal = defineSignal('pause')
export const resumeSignal = defineSignal('resume')
export const updateConfigSignal =
  defineSignal<[Partial<SyncConfig>]>('update_config')
export const deleteSignal = defineSignal('delete')

// Query
export const statusQuery = defineQuery<WorkflowStatus>('status')

export async function syncWorkflow(config: SyncConfig): Promise<void> {
  let cursors: Record<string, unknown> = config.cursors ?? {}
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
    config = {...config, ...newConfig}
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handler
  setHandler(statusQuery, (): WorkflowStatus => ({
    phase,
    paused,
    cursors,
    iteration,
  }))

  // --- Helpers ---

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  function updateCursors(
    stateMessages: Array<{stream?: string; data?: unknown}> | undefined,
  ) {
    if (!stateMessages) return
    for (const msg of stateMessages) {
      if (msg.stream) {
        cursors[msg.stream] = msg.data
      }
    }
  }

  function updateCursorsFromHash(stateHash: Record<string, unknown>) {
    for (const [stream, data] of Object.entries(stateHash)) {
      cursors[stream] = data
    }
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof syncWorkflow>({
        ...config,
        cursors,
        phase: phase as SyncConfig['phase'],
      })
    }
  }

  // --- Teardown ---

  async function runTeardown() {
    await destinationTeardown(config)
    await sourceTeardown(config)
  }

  // --- Setup phase ---

  async function runSetup() {
    if (deleted) {
      await runTeardown()
      return
    }
    await healthCheck(config)
    await sourceSetup(config)
    await destinationSetup(config)
  }

  // --- Backfill phase ---

  async function backfillStream(streamName: string) {
    let cursor = cursors[streamName]

    while (true) {
      await waitWhilePaused()
      if (deleted) return

      const result = await backfillPage(config, streamName, cursor)
      const records = result.records
      if (!records || records.length === 0) break

      const writeResult = await writeBatch(config, records)
      updateCursors(writeResult.states)
      cursor = cursors[streamName]

      await tickIteration()

      const complete = result.stream_statuses?.some(
        (s) => s.status === 'complete',
      )
      if (complete) break
    }
  }

  async function runBackfill() {
    const streams = config.streams ?? []
    for (const streamConfig of streams) {
      await backfillStream(streamConfig.name)
      if (deleted) {
        await runTeardown()
        return
      }
    }
  }

  // --- Live phase ---

  async function runLive() {
    while (true) {
      await waitWhilePaused()
      if (deleted) {
        await runTeardown()
        return
      }

      // Wait for events or 60s timeout
      await condition(
        () => eventBuffer.length > 0 || deleted,
        60_000,
      )

      if (eventBuffer.length === 0 && !deleted) continue
      if (deleted) {
        await runTeardown()
        return
      }

      // Process batch
      const batch = eventBuffer.splice(0, EVENT_BATCH_SIZE)
      if (batch.length > 0) {
        for (const event of batch) {
          const result = await processEvent(config, event)
          if (result.state && Object.keys(result.state).length > 0) {
            updateCursorsFromHash(result.state)
          }
        }
      }

      await tickIteration()
    }
  }

  // --- Phase state machine ---

  switch (phase) {
    case 'setup':
      await runSetup()
      if (deleted) return
      phase = 'backfill'
      await runBackfill()
      if (deleted) return
      phase = 'live'
      await runLive()
      break
    case 'backfill':
      await runBackfill()
      if (deleted) return
      phase = 'live'
      await runLive()
      break
    case 'live':
      await runLive()
      break
  }
}
