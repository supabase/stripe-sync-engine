import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  configQuery,
  deleteSignal,
  Pipeline,
  setup,
  stateQuery,
  statusQuery,
  stripeEventSignal,
  syncImmediate,
  teardown,
  toConfig,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface PipelineWorkflowOpts {
  state?: Record<string, unknown>
  timeLimit?: number
  inputQueue?: unknown[]
}

export async function pipelineWorkflow(
  pipeline: Pipeline,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let readComplete = false

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

  setHandler(statusQuery, (): WorkflowStatus => ({ phase: 'running', paused, iteration }))
  setHandler(configQuery, (): Pipeline => pipeline)
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipeline, {
        state: syncState,
        timeLimit: opts?.timeLimit,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  const setupResult = await setup(toConfig(pipeline))
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

  while (!deleted) {
    if (paused) {
      await condition(() => !paused || deleted)
      continue
    }

    if (readComplete && inputQueue.length === 0) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(
        () => paused || deleted || inputQueue.length > 0,
        ONE_WEEK_MS
      ))
      if (timedOut) readComplete = false
      continue
    }

    const config = toConfig(pipeline)

    if (inputQueue.length > 0) {
      const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
      await syncImmediate(config, { input: batch })
    } else {
      const result = await syncImmediate(config, {
        state: syncState,
        stateLimit: 1,
        timeLimit: opts?.timeLimit,
      })
      syncState = { ...syncState, ...result.state }
      readComplete = result.eof?.reason === 'complete'
    }

    await maybeContinueAsNew()
  }

  await teardown(toConfig(pipeline))
}
