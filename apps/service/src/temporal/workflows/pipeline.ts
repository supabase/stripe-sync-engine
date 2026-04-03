import { condition, continueAsNew, setHandler, sleep } from '@temporalio/workflow'

import {
  configQuery,
  deleteSignal,
  Pipeline,
  readIntoQueue,
  setup,
  stateQuery,
  statusQuery,
  stripeEventSignal,
  syncImmediate,
  teardown,
  toConfig,
  updateSignal,
  WorkflowStatus,
  writeFromQueue,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, deepEqual, EVENT_BATCH_SIZE } from '../../lib/utils.js'

export interface PipelineWorkflowOpts {
  phase?: string
  state?: Record<string, unknown>
  mode?: 'sync' | 'read-write'
  writeRps?: number
  pendingWrites?: boolean
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
  // pendingWrites is a coordination hint from the read loop to the write loop.
  // It avoids the write loop spinning on Kafka when the queue is known to be empty —
  // each writeFromQueue call creates a new consumer, joins the group, and waits 2s
  // for messages before returning. Without this gate the write loop would burn one
  // 2s activity invocation per tick just to learn "nothing to do."
  // The flag is best-effort: write self-corrects if it drifts (returns
  // written:0 when the queue is actually empty, written:>0 when it's not).
  let pendingWrites = opts?.pendingWrites ?? false

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

  const config = toConfig(pipeline)

  if (phase !== 'running') {
    const setupResult = await setup(config)
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

  if (opts?.mode === 'read-write') {
    let writeState: Record<string, unknown> = { ...syncState }
    let readState: Record<string, unknown> = { ...writeState }

    async function readLoop(): Promise<void> {
      while (!deleted) {
        await waitWhilePaused()
        if (deleted) break

        const config = toConfig(pipeline)

        if (inputQueue.length > 0) {
          const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
          const { count } = await readIntoQueue(config, pipeline.id, { input: batch })
          if (count > 0) pendingWrites = true
          await tickIteration()
          continue
        }

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
          await condition(() => pendingWrites || deleted)
        }
      }
    }

    await Promise.all([readLoop(), writeLoop()])
  } else {
    while (true) {
      await waitWhilePaused()
      if (deleted) break

      const config = toConfig(pipeline)

      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        await syncImmediate(config, { input: batch })
        await tickIteration()
        continue
      }

      if (!readComplete) {
        const before = syncState
        const result = await syncImmediate(config, { state: syncState, stateLimit: 1 })
        syncState = { ...syncState, ...result.state }
        readComplete = deepEqual(syncState, before)
        await tickIteration()
        continue
      }

      await condition(() => inputQueue.length > 0 || deleted)
    }
  }

  await teardown(toConfig(pipeline))
}
