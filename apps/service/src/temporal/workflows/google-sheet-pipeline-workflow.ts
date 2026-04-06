import { condition, continueAsNew, setHandler, sleep } from '@temporalio/workflow'
import type { ConfiguredCatalog, SourceInputMessage, SourceState } from '@stripe/sync-protocol'
import type { DesiredStatus, PipelineStatus } from '../../lib/createSchemas.js'
import { CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE } from '../../lib/utils.js'
import {
  desiredStatusSignal,
  discoverCatalog,
  pipelineSetup,
  pipelineTeardown,
  readIntoQueue,
  RowIndexMap,
  sourceInputSignal,
  updatePipelineStatus,
  writeGoogleSheetsFromQueue,
} from './_shared.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export type ReconcilePhase = 'backfilling' | 'reconciling' | 'ready'
export type SetupState = 'started' | 'completed'
export type TeardownState = 'started' | 'completed'

export interface GoogleSheetWorkflowState {
  phase?: ReconcilePhase
  paused?: boolean
  setup?: SetupState
  teardown?: TeardownState
  pendingWrites?: boolean
}

export interface GoogleSheetPipelineWorkflowOpts {
  desiredStatus?: DesiredStatus
  syncState?: SourceState
  readState?: SourceState
  rowIndexMap?: RowIndexMap
  catalog?: ConfiguredCatalog
  inputQueue?: SourceInputMessage[]
  state?: GoogleSheetWorkflowState
  writeRps?: number
}

export async function googleSheetPipelineWorkflow(
  pipelineId: string,
  opts?: GoogleSheetPipelineWorkflowOpts
): Promise<void> {
  // Persisted through continue-as-new.
  const inputQueue: SourceInputMessage[] = opts?.inputQueue ? [...opts.inputQueue] : []
  let desiredStatus: DesiredStatus = opts?.desiredStatus ?? 'active'
  let syncState: SourceState = opts?.syncState ?? { streams: {}, global: {} }
  let readState: SourceState = opts?.readState ?? syncState
  let rowIndexMap: RowIndexMap = opts?.rowIndexMap ?? {}
  let catalog: ConfiguredCatalog | undefined = opts?.catalog
  let state: GoogleSheetWorkflowState = { ...opts?.state }
  const writeRps = opts?.writeRps

  // Transient workflow-local state.
  let operationCount = 0

  setHandler(sourceInputSignal, (event: SourceInputMessage) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: DesiredStatus) => {
    desiredStatus = status
  })

  // MARK: - State

  function derivePipelineStatus(): PipelineStatus {
    if (state.teardown) return 'teardown'
    if (state.paused) return 'paused'
    if (state.setup !== 'completed') return 'setup'
    return state.phase === 'ready' ? 'ready' : 'backfill'
  }

  async function setState(next: Partial<GoogleSheetWorkflowState>) {
    const previousStatus = derivePipelineStatus()
    state = { ...state, ...next }
    const nextStatus = derivePipelineStatus()
    if (previousStatus !== nextStatus) {
      await updatePipelineStatus(pipelineId, nextStatus)
    }
  }

  function runInterrupted() {
    return desiredStatus !== 'active' || operationCount >= CONTINUE_AS_NEW_THRESHOLD
  }

  // MARK: - Live event loop

  async function waitForLiveEvents(): Promise<SourceInputMessage[] | null> {
    await condition(() => inputQueue.length > 0 || runInterrupted())
    if (runInterrupted()) return null
    return inputQueue.splice(0, EVENT_BATCH_SIZE)
  }

  async function liveEventLoop(): Promise<void> {
    while (true) {
      const events = await waitForLiveEvents()
      if (!events) return

      const { count } = await readIntoQueue(pipelineId, {
        input: events,
      })
      if (count > 0) await setState({ pendingWrites: true })
      operationCount++
    }
  }

  // MARK: - Reconcile loop

  async function waitForReconcileTurn(): Promise<boolean> {
    await condition(() => runInterrupted() || state.phase !== 'ready', ONE_WEEK_MS)
    if (runInterrupted()) return false
    return true
  }

  async function reconcileLoop(): Promise<void> {
    while (await waitForReconcileTurn()) {
      if (!state.phase) {
        await setState({ phase: 'backfilling' })
      } else if (state.phase === 'ready') {
        await setState({ phase: 'reconciling' })
      }

      const result = await readIntoQueue(pipelineId, {
        state: readState,
        state_limit: 1,
      })

      readState = result.state
      if (result.count > 0) await setState({ pendingWrites: true })
      if (result.eof?.reason === 'complete') await setState({ phase: 'ready' })

      operationCount++
    }
  }

  // MARK: - Write loop

  async function waitForPendingWrites(): Promise<boolean> {
    await condition(() => state.pendingWrites || runInterrupted())
    if (runInterrupted()) return false
    return true
  }

  async function writeLoop(): Promise<void> {
    while (await waitForPendingWrites()) {
      if (!catalog) catalog = await discoverCatalog(pipelineId)

      const result = await writeGoogleSheetsFromQueue(pipelineId, {
        maxBatch: 50,
        catalog,
        rowIndexMap,
        sourceState: syncState,
      })

      for (const [stream, assignments] of Object.entries(result.rowIndexMap)) {
        rowIndexMap[stream] ??= {}
        Object.assign(rowIndexMap[stream], assignments)
      }

      if (result.written > 0) {
        syncState = result.state
      } else {
        await setState({ pendingWrites: false })
      }

      if (writeRps) await sleep(Math.ceil(1000 / writeRps))
      operationCount++
    }
  }

  // MARK: - Main logic

  if (state.setup !== 'completed') {
    await setState({ setup: 'started' })
    if (!catalog) catalog = await discoverCatalog(pipelineId)
    await pipelineSetup(pipelineId)
    await setState({ setup: 'completed' })
  }

  while (desiredStatus !== 'deleted') {
    if (desiredStatus === 'paused') {
      await setState({ paused: true })
      await condition(() => desiredStatus !== 'paused')
      await setState({ paused: false })
      continue
    }

    await Promise.all([liveEventLoop(), reconcileLoop(), writeLoop()])

    if (operationCount >= CONTINUE_AS_NEW_THRESHOLD) {
      return await continueAsNew<typeof googleSheetPipelineWorkflow>(pipelineId, {
        desiredStatus,
        syncState,
        readState,
        rowIndexMap,
        catalog,
        inputQueue,
        state,
        writeRps,
      })
    }
  }

  await setState({ teardown: 'started' })
  await pipelineTeardown(pipelineId)
  await setState({ teardown: 'completed' })
}
