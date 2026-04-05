import { condition, continueAsNew, setHandler, sleep } from '@temporalio/workflow'
import type { ConfiguredCatalog } from '@stripe/sync-engine'

import {
  deleteSignal,
  discoverCatalog,
  readGoogleSheetsIntoQueue,
  RowIndex,
  setup,
  stateQuery,
  statusQuery,
  stripeEventSignal,
  teardown,
  updateSignal,
  WorkflowStatus,
  writeGoogleSheetsFromQueue,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, deepEqual, EVENT_BATCH_SIZE } from '../../lib/utils.js'

export interface GoogleSheetPipelineWorkflowOpts {
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

export async function googleSheetPipelineWorkflow(
  pipelineId: string,
  opts?: GoogleSheetPipelineWorkflowOpts
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
  setHandler(updateSignal, (patch) => {
    if (patch.paused !== undefined) paused = patch.paused
    // Config changes are written to the store directly by the API.
    // Reset catalog so the next read re-discovers it from updated config.
    // Note: we don't know if config actually changed vs just a pause toggle,
    // but re-discovering is cheap and safe.
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
  setHandler(stateQuery, (): Record<string, unknown> => sourceState)

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof googleSheetPipelineWorkflow>(pipelineId, {
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
    await setup(pipelineId)
    catalog = await discoverCatalog(pipelineId)
    if (deleted) {
      await teardown(pipelineId)
      return
    }
  }

  async function readLoop(): Promise<void> {
    while (!deleted) {
      await waitWhilePaused()
      if (deleted) break

      if (!catalog) catalog = await discoverCatalog(pipelineId)

      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        const { count } = await readGoogleSheetsIntoQueue(pipelineId, {
          input: batch,
          catalog,
        })
        if (count > 0) pendingWrites = true
        await tickIteration()
        continue
      }

      if (!readComplete) {
        const before = readState
        const { count, state: nextReadState } = await readGoogleSheetsIntoQueue(pipelineId, {
          state: readState,
          state_limit: 1,
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
        if (!catalog) catalog = await discoverCatalog(pipelineId)
        const result = await writeGoogleSheetsFromQueue(pipelineId, {
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
  await teardown(pipelineId)
}
