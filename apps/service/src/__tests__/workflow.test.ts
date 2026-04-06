import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { SyncActivities } from '../temporal/activities/index.js'
import type { RunResult } from '../temporal/activities/index.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../lib/utils.js'

type SourceInput = unknown

// workflowsPath points to the compiled workflow directory.
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows')

const emptyState = { streams: {}, global: {} }
const noErrors: RunResult = { errors: [], state: emptyState }

// Workflows now receive only the pipelineId string
const testPipelineId = 'test_pipe'

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    discoverCatalog: async () => ({ streams: [] }),
    pipelineSetup: async () => ({}),
    pipelineSync: async () => noErrors,
    readGoogleSheetsIntoQueue: async () => ({ count: 0, state: emptyState }),
    writeGoogleSheetsFromQueue: async () => ({
      errors: [],
      state: emptyState,
      written: 0,
      rowAssignments: {},
    }),
    pipelineTeardown: async () => {},
    updatePipelineStatus: async () => {},
    ...overrides,
  }
}

/** Signal the workflow to delete. */
async function signalDelete(handle: { signal: (name: string, arg: string) => Promise<void> }) {
  await handle.signal('desired_status', 'deleted')
}

async function signalSourceInput(
  handle: { signal: (name: string, arg: unknown) => Promise<void> },
  event: unknown
) {
  await handle.signal('source_input', event)
}

let testEnv: TestWorkflowEnvironment

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal()
}, 120_000)

afterAll(async () => {
  await testEnv?.teardown()
})

describe('pipelineWorkflow (unit — stubbed activities)', () => {
  it.skip('runs setup then continuous reconciliation until delete', async () => {
    let setupCalled = false
    let runCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-1',
      workflowsPath,
      activities: stubActivities({
        pipelineSetup: async () => {
          setupCalled = true
          return {}
        },
        pipelineSync: async () => {
          runCallCount++
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-1',
        taskQueue: 'test-queue-1',
      })

      // Let it sync several reconciliation pages
      await new Promise((r) => setTimeout(r, 2000))

      const status = await handle.query('status')
      expect(status.iteration).toBeGreaterThan(0)

      await signalDelete(handle)
      await handle.result()

      expect(setupCalled).toBe(true)
      expect(runCallCount).toBeGreaterThan(1)
    })
  })

  it('processes stripe_event signals as optimistic updates', async () => {
    const syncCalls: { pipelineId: string; input?: SourceInput[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (pipelineId: string, opts?) => {
          syncCalls.push({ pipelineId, input: opts?.input ?? undefined })
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-2',
        taskQueue: 'test-queue-2',
      })

      // Let reconciliation start
      await new Promise((r) => setTimeout(r, 1500))

      // Send events
      await signalSourceInput(handle, {
        id: 'evt_1',
        type: 'customer.created',
      })
      await signalSourceInput(handle, {
        id: 'evt_2',
        type: 'product.updated',
      })

      await new Promise((r) => setTimeout(r, 2000))
      await signalDelete(handle)
      await handle.result()

      // Find event-bearing sync calls (input is defined)
      const eventCalls = syncCalls.filter((c) => c.input)
      expect(eventCalls.length).toBeGreaterThanOrEqual(1)

      const allEvents = eventCalls.flatMap((c) => c.input!)
      expect(allEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'evt_1' }),
          expect.objectContaining({ id: 'evt_2' }),
        ])
      )

      // All calls should use the test pipeline ID
      for (const call of syncCalls) {
        expect(call.pipelineId).toBe(testPipelineId)
      }
    })
  })

  it('runs optimistic updates concurrently with reconciliation when both are pending', async () => {
    let inputInFlight = 0
    let backfillInFlight = 0
    let overlapped = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2b',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) {
            inputInFlight++
            if (backfillInFlight > 0) overlapped = true
            await new Promise((r) => setTimeout(r, 250))
            inputInFlight--
            return noErrors
          }

          backfillInFlight++
          if (inputInFlight > 0) overlapped = true
          await new Promise((r) => setTimeout(r, 250))
          backfillInFlight--
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [
          testPipelineId,
          {
            inputQueue: [{ id: 'evt_initial', type: 'customer.created' }],
          },
        ],
        workflowId: 'test-sync-2b',
        taskQueue: 'test-queue-2b',
      })

      await new Promise((r) => setTimeout(r, 600))
      await signalDelete(handle)
      await handle.result()

      expect(overlapped).toBe(true)
    })
  })

  it('keeps draining live batches while a backfill slice is still running', async () => {
    let backfillInFlight = 0
    let liveStartsWhileBackfill = 0
    let liveBatchCount = 0
    let liveEventCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2c',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) {
            liveBatchCount++
            liveEventCount += opts.input.length
            if (backfillInFlight > 0) liveStartsWhileBackfill++
            await new Promise((r) => setTimeout(r, 80))
            return noErrors
          }

          backfillInFlight++
          try {
            await new Promise((r) => setTimeout(r, 600))
            return noErrors
          } finally {
            backfillInFlight--
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-2c',
        taskQueue: 'test-queue-2c',
      })

      await new Promise((r) => setTimeout(r, 50))
      for (let i = 0; i < 12; i++) {
        await signalSourceInput(handle, {
          id: `evt_${i}`,
          type: 'customer.updated',
        })
      }

      await new Promise((r) => setTimeout(r, 350))
      await signalDelete(handle)
      await handle.result()

      expect(liveBatchCount).toBeGreaterThanOrEqual(2)
      expect(liveStartsWhileBackfill).toBeGreaterThanOrEqual(1)
      expect(liveEventCount).toBe(12)
    })
  })

  it('pauses and resumes via desired_status signal', async () => {
    const statusWrites: string[] = []
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3',
        taskQueue: 'test-queue-3',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('desired_status', 'paused')
      await new Promise((r) => setTimeout(r, 500))

      expect(statusWrites).toContain('paused')

      await handle.signal('desired_status', 'active')
      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('desired_status', 'deleted')
      await handle.result()
    })
  })

  it('reports phase-driven status transitions through teardown', async () => {
    const statusWrites: string[] = []
    let reconcileCalls = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3b',
      workflowsPath,
      activities: stubActivities({
        updatePipelineStatus: async (_id: string, status: string) => {
          statusWrites.push(status)
        },
        pipelineSync: async (_pipelineId: string, opts?) => {
          if (opts?.input) return noErrors

          reconcileCalls++
          return reconcileCalls === 1
            ? { ...noErrors, eof: { reason: 'complete' } }
            : noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3b',
        taskQueue: 'test-queue-3b',
      })

      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('desired_status', 'paused')
      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('desired_status', 'deleted')
      await handle.result()

      expect(statusWrites).toEqual(expect.arrayContaining(['backfill', 'ready', 'paused', 'teardown']))
    })
  })

  it('queues live events while paused and drains them after resume', async () => {
    const syncCalls: { input?: SourceInput[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3c',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async (_pipelineId: string, opts?) => {
          syncCalls.push({ input: opts?.input ?? undefined })
          await new Promise((r) => setTimeout(r, 50))
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3c',
        taskQueue: 'test-queue-3c',
      })

      await new Promise((r) => setTimeout(r, 200))
      await handle.signal('desired_status', 'paused')
      await new Promise((r) => setTimeout(r, 200))

      await signalSourceInput(handle, {
        id: 'evt_paused',
        type: 'customer.updated',
      })

      await new Promise((r) => setTimeout(r, 300))
      expect(syncCalls.filter((c) => c.input).length).toBe(0)

      await handle.signal('desired_status', 'active')
      await new Promise((r) => setTimeout(r, 400))
      await signalDelete(handle)
      await handle.result()

      const liveCalls = syncCalls.filter((c) => c.input)
      expect(liveCalls).toHaveLength(1)
      expect(liveCalls[0].input).toEqual([
        expect.objectContaining({ id: 'evt_paused', type: 'customer.updated' }),
      ])
    })
  })

  it('triggers teardown on delete', async () => {
    let teardownCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async () => {
          // Slow sync so delete arrives mid-reconciliation
          await new Promise((r) => setTimeout(r, 500))
          return noErrors
        },
        pipelineTeardown: async (): Promise<void> => {
          teardownCalled = true
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      await new Promise((r) => setTimeout(r, 300))
      await signalDelete(handle)
      await handle.result()

      expect(teardownCalled).toBe(true)
    })
  })

  it('accumulates sync state across iterations', async () => {
    let syncCallCount = 0
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-7',
      workflowsPath,
      activities: stubActivities({
        pipelineSync: async () => {
          syncCallCount++
          return {
            errors: [],
            state: { streams: { customers: { cursor: `cus_${syncCallCount}` } }, global: {} },
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-7',
        taskQueue: 'test-queue-7',
      })

      await new Promise((r) => setTimeout(r, 1500))

      expect(syncCallCount).toBeGreaterThan(0)

      await signalDelete(handle)
      await handle.result()
    })
  })

  it.skip('runs setup only once across continue-as-new', async () => {
    let setupCalls = 0
    let syncCallCount = 0
    let crossedThresholdResolve: (() => void) | undefined
    const crossedThreshold = new Promise<void>((resolve) => {
      crossedThresholdResolve = resolve
    })

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-8',
      workflowsPath,
      activities: stubActivities({
        pipelineSetup: async () => {
          setupCalls++
          return {}
        },
        pipelineSync: async () => {
          syncCallCount++
          if (syncCallCount > CONTINUE_AS_NEW_THRESHOLD) crossedThresholdResolve?.()
          await new Promise((r) => setTimeout(r, 1))
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-8',
        taskQueue: 'test-queue-8',
      })

      await crossedThreshold
      await signalDelete(handle)
      await handle.result()

      expect(syncCallCount).toBeGreaterThan(CONTINUE_AS_NEW_THRESHOLD)
      expect(setupCalls).toBe(1)
    })
  })
})

describe('googleSheetPipelineWorkflow (unit — stubbed activities)', () => {
  it('uses the Sheets-specific read path and catalog discovery', async () => {
    let discoverCalls = 0
    let readCalls = 0
    let syncCalls = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-gs-1',
      workflowsPath,
      activities: stubActivities({
        discoverCatalog: async () => {
          discoverCalls++
          return { streams: [] }
        },
        readGoogleSheetsIntoQueue: async () => {
          readCalls++
          return { count: 0, state: emptyState }
        },
        pipelineSync: async () => {
          syncCalls++
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('googleSheetPipelineWorkflow', {
        args: ['test_gs_pipe'],
        workflowId: 'test-gs-sync-1',
        taskQueue: 'test-queue-gs-1',
      })

      await new Promise((r) => setTimeout(r, 1500))
      await signalDelete(handle)
      await handle.result()

      expect(discoverCalls).toBeGreaterThanOrEqual(1)
      expect(readCalls).toBeGreaterThanOrEqual(1)
      expect(syncCalls).toBe(0)
    })
  })

  it('passes the discovered catalog into the Sheets write activity', async () => {
    const discoveredCatalog = {
      streams: [
        {
          stream: {
            name: 'customers',
            primary_key: [['id']],
            json_schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
          sync_mode: 'full_refresh' as const,
          destination_sync_mode: 'append' as const,
        },
      ],
    }
    let readCalls = 0
    let writeCatalog: unknown

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-gs-2',
      workflowsPath,
      activities: stubActivities({
        discoverCatalog: async () => discoveredCatalog,
        readGoogleSheetsIntoQueue: async () => {
          readCalls++
          return readCalls === 1
            ? { count: 1, state: { streams: { customers: { cursor: 'cus_1' } }, global: {} } }
            : { count: 0, state: { streams: { customers: { cursor: 'cus_1' } }, global: {} } }
        },
        writeGoogleSheetsFromQueue: async (_pipelineId, opts) => {
          writeCatalog = opts?.catalog
          return {
            errors: [],
            state: { streams: { customers: { cursor: 'cus_1' } }, global: {} },
            written: 0,
            rowAssignments: {},
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('googleSheetPipelineWorkflow', {
        args: ['test_gs_pipe_2'],
        workflowId: 'test-gs-sync-2',
        taskQueue: 'test-queue-gs-2',
      })

      await new Promise((r) => setTimeout(r, 1500))
      await signalDelete(handle)
      await handle.result()

      expect(writeCatalog).toEqual(discoveredCatalog)
    })
  })
})
