import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { SyncActivities, SyncResult } from '../types'

// workflowsPath must point to compiled JS (Temporal bundles it for V8 sandbox)
const workflowsPath = path.resolve(process.cwd(), 'dist/workflows.js')

const config = {
  source_name: 'stripe',
  destination_name: 'postgres',
  source_config: { api_key: 'sk_test_xxx' },
  destination_config: { connection_string: 'postgres://localhost/test' },
  streams: [{ name: 'customers' }, { name: 'products' }],
}

const completeResult: SyncResult = {
  state: {
    customers: { status: 'complete' },
    products: { status: 'complete' },
  },
  all_complete: true,
  state_count: 2,
  errors: [],
}

const emptyResult: SyncResult = {
  state: {},
  all_complete: false,
  state_count: 0,
  errors: [],
}

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    setup: async () => {},
    sync: async () => completeResult,
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

describe('SyncWorkflow', () => {
  it('runs setup, backfill, then waits for events until delete', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-1',
      workflowsPath,
      activities: stubActivities(),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-1',
        taskQueue: 'test-queue-1',
      })

      // Let it reach live phase, then delete
      await new Promise((r) => setTimeout(r, 2000))
      await handle.signal('delete')
      await handle.result()
    })
  })

  it('pages through backfill until all_complete', async () => {
    let syncCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        sync: async () => {
          syncCallCount++
          if (syncCallCount < 3) {
            return {
              state: { customers: { cursor: `page_${syncCallCount}` } },
              all_complete: false,
              state_count: 1,
              errors: [],
            }
          }
          return completeResult
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-2',
        taskQueue: 'test-queue-2',
      })

      // Backfill pages then enters live, signal delete
      await new Promise((r) => setTimeout(r, 3000))
      await handle.signal('delete')
      await handle.result()

      expect(syncCallCount).toBeGreaterThanOrEqual(3)
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
        args: [config],
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

  it('processes stripe_event signals', async () => {
    const syncCalls: unknown[][] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        sync: async (_config, input?) => {
          if (input) syncCalls.push(input)
          return completeResult
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      // Wait for live phase
      await new Promise((r) => setTimeout(r, 2000))
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

      // sync should have been called with the events as input
      expect(syncCalls.length).toBeGreaterThanOrEqual(1)
      const allEvents = syncCalls.flat()
      expect(allEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'evt_1' }),
          expect.objectContaining({ id: 'evt_2' }),
        ])
      )
    })
  })

  it('triggers teardown on delete during backfill', async () => {
    let teardownCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-5',
      workflowsPath,
      activities: stubActivities({
        sync: async () => {
          // Slow sync so delete arrives mid-backfill
          await new Promise((r) => setTimeout(r, 500))
          return {
            state: { customers: { cursor: 'page_1' } },
            all_complete: false,
            state_count: 1,
            errors: [],
          }
        },
        teardown: async () => {
          teardownCalled = true
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-5',
        taskQueue: 'test-queue-5',
      })

      await new Promise((r) => setTimeout(r, 300))
      await handle.signal('delete')
      await handle.result()

      expect(teardownCalled).toBe(true)
    })
  })
})
