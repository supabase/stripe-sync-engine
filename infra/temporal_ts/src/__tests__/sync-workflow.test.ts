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

const pageResult: SyncResult = {
  state: {
    customers: { cursor: 'page_1' },
    products: { cursor: 'page_1' },
  },
  all_complete: false,
  state_count: 2,
  errors: [],
}

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    setup: async () => {},
    sync: async () => pageResult,
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
  it('runs setup then continuous reconciliation until delete', async () => {
    let setupCalled = false
    let syncCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-1',
      workflowsPath,
      activities: stubActivities({
        setup: async () => {
          setupCalled = true
        },
        sync: async () => {
          syncCallCount++
          return pageResult
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-1',
        taskQueue: 'test-queue-1',
      })

      // Let it run several reconciliation pages
      await new Promise((r) => setTimeout(r, 2000))

      const status = await handle.query('status')
      expect(status.phase).toBe('running')
      expect(status.iteration).toBeGreaterThan(0)

      await handle.signal('delete')
      await handle.result()

      expect(setupCalled).toBe(true)
      expect(syncCallCount).toBeGreaterThan(1)
    })
  })

  it('accumulates state across reconciliation pages', async () => {
    let syncCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        sync: async (cfg) => {
          syncCallCount++
          // Return different cursors each page to verify accumulation
          return {
            state: { customers: { cursor: `page_${syncCallCount}` } },
            all_complete: syncCallCount >= 3,
            state_count: 1,
            errors: [],
          }
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-2',
        taskQueue: 'test-queue-2',
      })

      // Let it run several pages — reconciliation continues even after all_complete
      await new Promise((r) => setTimeout(r, 3000))

      const status = await handle.query('status')
      // State should have accumulated cursor from latest page
      expect(status.state).toHaveProperty('customers')

      // Reconciliation keeps running past all_complete
      expect(syncCallCount).toBeGreaterThan(3)

      await handle.signal('delete')
      await handle.result()
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

  it('processes stripe_event signals as stateless optimistic updates', async () => {
    const syncCalls: { config: any; input?: unknown[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities({
        sync: async (cfg, input?) => {
          syncCalls.push({ config: cfg, input: input ?? undefined })
          return pageResult
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      // Let reconciliation start
      await new Promise((r) => setTimeout(r, 1500))

      // Send events — these should be processed as stateless optimistic updates
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

      // Event calls should NOT include state in config (stateless)
      for (const call of eventCalls) {
        expect(call.config).not.toHaveProperty('state')
      }
    })
  })

  it('triggers teardown on delete during reconciliation', async () => {
    let teardownCalled = false

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-5',
      workflowsPath,
      activities: stubActivities({
        sync: async () => {
          // Slow sync so delete arrives mid-reconciliation
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
