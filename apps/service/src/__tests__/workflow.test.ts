import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import path from 'node:path'
import type { PipelineConfig } from '@stripe/sync-engine'
import type { SyncActivities } from '../temporal/activities.js'
import type { RunResult } from '../temporal/activities.js'

// workflowsPath must point to compiled JS (Temporal bundles it for V8 sandbox)
const workflowsPath = path.resolve(process.cwd(), 'dist/temporal/workflows.js')

const noErrors: RunResult = { errors: [], state: {} }

const testPipeline = {
  id: 'test_pipe',
  source: { type: 'test', api_key: 'sk_test_123' },
  destination: { type: 'test' },
}

function stubActivities(overrides: Partial<SyncActivities> = {}): SyncActivities {
  return {
    setup: async () => ({}),
    syncImmediate: async () => noErrors,
    readIntoQueue: async () => ({ count: 0, state: {} }),
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
        args: [testPipeline],
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
    const syncCalls: { config: PipelineConfig; input?: unknown[] }[] = []

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        syncImmediate: async (config: PipelineConfig, opts?) => {
          syncCalls.push({ config, input: opts?.input ?? undefined })
          return noErrors
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipeline],
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

      // All calls should use the same pipeline config
      for (const call of syncCalls) {
        expect(call.config.source.type).toBe('test')
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
        args: [testPipeline],
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
        args: [testPipeline],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

      await new Promise((r) => setTimeout(r, 300))
      await handle.signal('delete')
      await handle.result()

      expect(teardownCalled).toBe(true)
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
          return {}
        },
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipeline, { phase: 'running' }],
        workflowId: 'test-sync-5',
        taskQueue: 'test-queue-5',
      })

      await new Promise((r) => setTimeout(r, 1000))
      await handle.signal('delete')
      await handle.result()

      expect(setupCalled).toBe(false)
    })
  })

  it('returns pipeline config via config query', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-6',
      workflowsPath,
      activities: stubActivities(),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('pipelineWorkflow', {
        args: [testPipeline],
        workflowId: 'test-sync-6',
        taskQueue: 'test-queue-6',
      })

      await new Promise((r) => setTimeout(r, 500))

      const config = await handle.query('config')
      expect(config.id).toBe('test_pipe')
      expect(config.source.type).toBe('test')

      await handle.signal('delete')
      await handle.result()
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
        args: [testPipeline],
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
