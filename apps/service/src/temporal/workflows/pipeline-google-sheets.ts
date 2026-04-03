import { condition, continueAsNew, setHandler, sleep } from '@temporalio/workflow'
import type { ConfiguredCatalog } from '@stripe/sync-engine'

import {
  configQuery,
  deleteSignal,
  discoverCatalog,
  Pipeline,
  readIntoQueueWithState,
  RowIndex,
  setup,
  stateQuery,
  statusQuery,
  stripeEventSignal,
  teardown,
  toConfig,
  updateSignal,
  WorkflowStatus,
  writeGoogleSheetsFromQueue,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, deepEqual, EVENT_BATCH_SIZE } from '../../lib/utils.js'

export interface PipelineGoogleSheetsWorkflowOpts {
  phase?: string
  sourceState?: Record<string, unknown>
  readState?: Record<string, unknown>
  rowIndex?: RowIndex
  catalog?: ConfiguredCatalog
  pendingWrites?: boolean
  inputQueue?: unknown[]
  readComplete?: boolean
  writeRps?: number
}

export async function pipelineGoogleSheetsWorkflow(
  pipeline: Pipeline,
  opts?: PipelineGoogleSheetsWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let sourceState: Record<string, unknown> = opts?.sourceState ?? {}
  let readState: Record<string, unknown> = opts?.readState ?? { ...sourceState }
  let rowIndex: RowIndex = opts?.rowIndex ?? {}
  let catalog: ConfiguredCatalog | undefined = opts?.catalog
  let readComplete = opts?.readComplete ?? false
  let pendingWrites = opts?.pendingWrites ?? false

  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(updateSignal, (patch: Partial<Pipeline>) => {
    if (patch.source) {
      pipeline = { ...pipeline, source: patch.source }
      catalog = undefined
      readComplete = false
      readState = { ...sourceState }
    }
    if (patch.destination) pipeline = { ...pipeline, destination: patch.destination }
    if (patch.streams !== undefined) {
      pipeline = { ...pipeline, streams: patch.streams }
      catalog = undefined
      readComplete = false
      readState = { ...sourceState }
    }
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
  setHandler(stateQuery, (): Record<string, unknown> => sourceState)

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineGoogleSheetsWorkflow>(pipeline, {
        phase: 'running',
        sourceState,
        readState,
        rowIndex,
        catalog,
        pendingWrites,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
        readComplete,
        writeRps: opts?.writeRps,
      })
    }
  }

  if (phase !== 'running') {
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
    catalog = await discoverCatalog(toConfig(pipeline))
    if (deleted) {
      await teardown(toConfig(pipeline))
      return
    }
  }

  async function readLoop(): Promise<void> {
    while (!deleted) {
      await waitWhilePaused()
      if (deleted) break

      const config = toConfig(pipeline)
      if (!catalog) catalog = await discoverCatalog(config)

      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        const { count } = await readIntoQueueWithState(config, pipeline.id, {
          input: batch,
          catalog,
        })
        if (count > 0) pendingWrites = true
        await tickIteration()
        continue
      }

      if (!readComplete) {
        const before = readState
        const { count, state: nextReadState } = await readIntoQueueWithState(config, pipeline.id, {
          state: readState,
          stateLimit: 1,
          catalog,
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
        if (!catalog) catalog = await discoverCatalog(toConfig(pipeline))
        const result = await writeGoogleSheetsFromQueue(toConfig(pipeline), pipeline.id, {
          maxBatch: 50,
          rowIndex,
          catalog,
        })
        pendingWrites = result.written > 0
        sourceState = { ...sourceState, ...result.state }
        for (const [stream, assignments] of Object.entries(result.rowAssignments)) {
          rowIndex[stream] ??= {}
          Object.assign(rowIndex[stream], assignments)
        }
        if (opts?.writeRps) await sleep(Math.ceil(1000 / opts.writeRps))
        await tickIteration()
      } else {
        await condition(() => pendingWrites || deleted)
      }
    }
  }

  await Promise.all([readLoop(), writeLoop()])
  await teardown(toConfig(pipeline))
}
