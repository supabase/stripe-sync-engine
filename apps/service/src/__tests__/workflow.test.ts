import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { SyncActivities } from '../temporal/activities/index.js'
import type { RunResult } from '../temporal/activities/index.js'

type SourceInput = unknown

// workflowsPath points to the compiled workflow directory.
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows')

const noErrors: RunResult = { errors: [], state: {} }

// Workflows now receive only the pipelineId string
const testPipelineId = 'test_pipe'

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    discoverCatalog: async () => ({ streams: [] }),
    setup: async () => ({}),
    syncImmediate: async () => noErrors,
    readGoogleSheetsIntoQueue: async () => ({ count: 0, state: {} }),
    readIntoQueue: async () => ({ count: 0, state: {} }),
    writeGoogleSheetsFromQueue: async () => ({
      errors: [],
      state: {},
      written: 0,
      rowAssignments: {},
    }),
    writeFromQueue: async () => ({ errors: [], state: {}, written: 0 }),
    teardown: async () => {},
    ...overrides,
  }
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
        setup: async () => {
          setupCalled = true
          return {}
        },
        syncImmediate: async () => {
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

      await handle.signal('delete')
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
        syncImmediate: async (pipelineId: string, opts?) => {
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
      await handle.signal('stripe_event', {
        id: 'evt_1',
        type: 'customer.created',
      })
      await handle.signal('stripe_event', {
        id: 'evt_2',
        type: 'product.updated',
      })

      await new Promise((r) => setTimeout(r, 2000))
      await handle.signal('delete')
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

  it('pauses and resumes via update signal', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3',
      workflowsPath,
      activities: stubActivities(),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-3',
        taskQueue: 'test-queue-3',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('update', { paused: true })
      await new Promise((r) => setTimeout(r, 500))

      const status = await handle.query('status')
      expect(status.paused).toBe(true)

      await handle.signal('update', { paused: false })
      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('delete')
      await handle.result()
    })
  })

  it('triggers teardown on delete', async () => {
    let teardownCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        syncImmediate: async () => {
          // Slow sync so delete arrives mid-reconciliation
          await new Promise((r) => setTimeout(r, 500))
          return noErrors
        },
        teardown: async (): Promise<void> => {
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
      await handle.signal('delete')
      await handle.result()

      expect(teardownCalled).toBe(true)
    })
  })

  it('returns sync state via state query', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-7',
      workflowsPath,
      activities: stubActivities({
        syncImmediate: async () => ({ errors: [], state: { customers: { cursor: 'cus_100' } } }),
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipelineId],
        workflowId: 'test-sync-7',
        taskQueue: 'test-queue-7',
      })

      await new Promise((r) => setTimeout(r, 1500))

      const state = await handle.query('state')
      expect(state).toHaveProperty('customers')

      await handle.signal('delete')
      await handle.result()
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
          return { count: 0, state: {} }
        },
        syncImmediate: async () => {
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
      await handle.signal('delete')
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
            ? { count: 1, state: { customers: { cursor: 'cus_1' } } }
            : { count: 0, state: { customers: { cursor: 'cus_1' } } }
        },
        writeGoogleSheetsFromQueue: async (_pipelineId, opts) => {
          writeCatalog = opts?.catalog
          return {
            errors: [],
            state: { customers: { cursor: 'cus_1' } },
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
      await handle.signal('delete')
      await handle.result()

      expect(writeCatalog).toEqual(discoveredCatalog)
    })
  })
})
