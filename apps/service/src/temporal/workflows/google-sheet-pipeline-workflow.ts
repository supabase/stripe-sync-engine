import { condition, continueAsNew, setHandler, sleep } from '@temporalio/workflow'
import type {
  ConfiguredCatalog,
  SourceInputMessage,
  SourceState as SyncState,
} from '@stripe/sync-engine'

import {
  desiredStatusSignal,
  discoverCatalog,
  pipelineSetup,
  pipelineTeardown,
  readGoogleSheetsIntoQueue,
  RowIndex,
  sourceInputSignal,
  updatePipelineStatus,
  writeGoogleSheetsFromQueue,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, deepEqual, EVENT_BATCH_SIZE } from '../../lib/utils.js'

export interface GoogleSheetPipelineWorkflowOpts {
  desiredStatus?: string
  setupDone?: boolean
  state?: SyncState
  readState?: SyncState
  rowIndex?: RowIndex
  catalog?: ConfiguredCatalog
  pendingWrites?: boolean
  inputQueue?: SourceInputMessage[]
  readComplete?: boolean
  writeRps?: number
}

export async function googleSheetPipelineWorkflow(
  pipelineId: string,
  opts?: GoogleSheetPipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  const inputQueue: SourceInputMessage[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let setupDone = opts?.setupDone ?? false
  let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
  let readState: SyncState = opts?.readState ?? {
    streams: { ...syncState.streams },
    global: { ...syncState.global },
  }
  let rowIndex: RowIndex = opts?.rowIndex ?? {}
  let catalog: ConfiguredCatalog | undefined = opts?.catalog
  let readComplete = opts?.readComplete ?? false
  let pendingWrites = opts?.pendingWrites ?? false

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: string) => {
    desiredStatus = status
  })

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof googleSheetPipelineWorkflow>(pipelineId, {
        desiredStatus,
        setupDone: true,
        state: syncState,
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

  function shouldStop() {
    return desiredStatus === 'deleted' || desiredStatus === 'paused'
  }

  // Setup
  if (!setupDone) {
    await pipelineSetup(pipelineId)
    catalog = await discoverCatalog(pipelineId)
    setupDone = true
    if (desiredStatus === 'deleted') {
      await updatePipelineStatus(pipelineId, 'teardown')
      await pipelineTeardown(pipelineId)
      return
    }
  }

  await updatePipelineStatus(pipelineId, readComplete ? 'ready' : 'backfill')

  async function readLoop(): Promise<void> {
    while (!shouldStop()) {
      if (!catalog) catalog = await discoverCatalog(pipelineId)

      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        const { count } = await readGoogleSheetsIntoQueue(pipelineId, {
          input: batch,
          catalog,
          rowIndex,
        })
        if (count > 0) pendingWrites = true
        await maybeContinueAsNew()
        continue
      }

      if (!readComplete) {
        const before = readState
        const { count, state: nextReadState } = await readGoogleSheetsIntoQueue(pipelineId, {
          state: readState,
          state_limit: 1,
          catalog,
          rowIndex,
        })
        if (count > 0) pendingWrites = true
        readState = {
          streams: { ...readState.streams, ...nextReadState.streams },
          global: { ...readState.global, ...nextReadState.global },
        }
        if (count === 0 || deepEqual(readState, before)) {
          readComplete = true
          await updatePipelineStatus(pipelineId, 'ready')
        }
        await maybeContinueAsNew()
        continue
      }

      await condition(() => inputQueue.length > 0 || shouldStop())
    }
  }

  async function writeLoop(): Promise<void> {
    while (!shouldStop()) {
      if (pendingWrites) {
        if (!catalog) catalog = await discoverCatalog(pipelineId)
        const result = await writeGoogleSheetsFromQueue(pipelineId, {
          maxBatch: 50,
          catalog,
        })
        pendingWrites = result.written > 0
        if (result.written > 0) syncState = result.state
        for (const [stream, assignments] of Object.entries(result.rowAssignments)) {
          rowIndex[stream] ??= {}
          Object.assign(rowIndex[stream], assignments)
        }
        if (opts?.writeRps) await sleep(Math.ceil(1000 / opts.writeRps))
        await maybeContinueAsNew()
      } else {
        await condition(() => pendingWrites || shouldStop())
      }
    }
  }

  // Main loop: handle pause/delete/active cycling
  while (desiredStatus !== 'deleted') {
    if (desiredStatus === 'deleted') break

    if (desiredStatus === 'paused') {
      await updatePipelineStatus(pipelineId, 'paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    // Active — run read/write loops until paused or deleted
    await updatePipelineStatus(pipelineId, readComplete ? 'ready' : 'backfill')
    await Promise.all([readLoop(), writeLoop()])
  }

  await updatePipelineStatus(pipelineId, 'teardown')
  await pipelineTeardown(pipelineId)
}
