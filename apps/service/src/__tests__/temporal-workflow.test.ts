import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { SyncActivities, RunResult } from '../temporal/types.js'

// workflowsPath must point to compiled JS (Temporal bundles it for V8 sandbox)
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

const noErrors: RunResult = { errors: [] }

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    setup: async () => {},
    run: async () => noErrors,
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

describe('syncWorkflow (unit — stubbed activities)', () => {
  it('runs setup then continuous reconciliation until delete', async () => {
    let setupCalled = false
    let runCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-1',
      workflowsPath,
      activities: stubActivities({
        setup: async () => {
          setupCalled = true
        },
        run: async () => {
          runCallCount++
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: ['sync_test_1'],
        workflowId: 'test-sync-1',
        taskQueue: 'test-queue-1',
      })

      // Let it run several reconciliation pages
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
    const runCalls: { syncId: string; input?: unknown[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        run: async (syncId: string, input?: unknown[]) => {
          runCalls.push({ syncId, input: input ?? undefined })
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: ['sync_test_2'],
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

      // Find event-bearing run calls (input is defined)
      const eventCalls = runCalls.filter((c) => c.input)
      expect(eventCalls.length).toBeGreaterThanOrEqual(1)

      const allEvents = eventCalls.flatMap((c) => c.input!)
      expect(allEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'evt_1' }),
          expect.objectContaining({ id: 'evt_2' }),
        ])
      )

      // All calls should use the same syncId
      for (const call of runCalls) {
        expect(call.syncId).toBe('sync_test_2')
      }
    })
  })

  it('pauses and resumes processing', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-3',
      workflowsPath,
      activities: stubActivities(),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: ['sync_test_3'],
        workflowId: 'test-sync-3',
        taskQueue: 'test-queue-3',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('pause')
      await new Promise((r) => setTimeout(r, 500))

      const status = await handle.query('status')
      expect(status.paused).toBe(true)

      await handle.signal('resume')
      await new Promise((r) => setTimeout(r, 500))
      await handle.signal('delete')
      await handle.result()
    })
  })

  it('triggers teardown on delete', async () => {
    let teardownCalled = false
    let teardownSyncId: string | undefined

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        run: async () => {
          // Slow run so delete arrives mid-reconciliation
          await new Promise((r) => setTimeout(r, 500))
          return noErrors
        },
        teardown: async (syncId: string) => {
          teardownCalled = true
          teardownSyncId = syncId
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: ['sync_test_4'],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      await new Promise((r) => setTimeout(r, 300))
      await handle.signal('delete')
      await handle.result()

      expect(teardownCalled).toBe(true)
      expect(teardownSyncId).toBe('sync_test_4')
    })
  })

  it('skips setup when phase is running (continueAsNew case)', async () => {
    let setupCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-5',
      workflowsPath,
      activities: stubActivities({
        setup: async () => {
          setupCalled = true
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: ['sync_test_5', { phase: 'running' }],
        workflowId: 'test-sync-5',
        taskQueue: 'test-queue-5',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('delete')
      await handle.result()

      expect(setupCalled).toBe(false)
    })
  })
})
