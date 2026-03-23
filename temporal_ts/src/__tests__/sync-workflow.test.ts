import {describe, it, expect, beforeAll, afterAll} from 'vitest'
import {TestWorkflowEnvironment} from '@temporalio/testing'
import {Worker} from '@temporalio/worker'
import path from 'node:path'
import type {SyncActivities, CategorizedMessages} from '../types'

// workflowsPath must point to compiled JS (Temporal bundles it for V8 sandbox)
const workflowsPath = path.resolve(process.cwd(), 'dist/workflows.js')

const config = {
  source_name: 'stripe',
  destination_name: 'postgres',
  source_config: {api_key: 'sk_test_xxx'},
  destination_config: {connection_string: 'postgres://localhost/test'},
  streams: [{name: 'customers'}, {name: 'products'}],
}

const emptyResult: CategorizedMessages = {
  records: [],
  states: [],
  errors: [],
  stream_statuses: [],
  messages: [],
}

function stubActivities(
  overrides: Partial<SyncActivities> = {},
): SyncActivities {
  return {
    healthCheck: async () => ({
      source: {status: 'succeeded'},
      destination: {status: 'succeeded'},
    }),
    sourceSetup: async () => {},
    destinationSetup: async () => {},
    sourceTeardown: async () => {},
    destinationTeardown: async () => {},
    backfillPage: async () => emptyResult,
    writeBatch: async () => emptyResult,
    processEvent: async () => ({records_written: 0, state: {}}),
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
  it('runs through setup → backfill → live phases then exits on delete', async () => {
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

  it('pages through backfill records and writes them', async () => {
    let backfillCallCount = 0

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-2',
      workflowsPath,
      activities: stubActivities({
        backfillPage: async (_config, stream, _cursor) => {
          backfillCallCount++
          if (backfillCallCount <= 2) {
            return {
              records: [
                {
                  type: 'record',
                  stream,
                  data: {id: `obj_${backfillCallCount}`},
                  emitted_at: Date.now(),
                },
              ],
              states: [],
              errors: [],
              stream_statuses: [],
              messages: [],
            }
          }
          return emptyResult
        },
        writeBatch: async () => ({
          records: [],
          states: [
            {
              type: 'state' as const,
              stream: 'customers',
              data: {cursor: 'abc'},
            },
          ],
          errors: [],
          stream_statuses: [],
          messages: [
            {type: 'state', stream: 'customers', data: {cursor: 'abc'}},
          ],
        }),
      }),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-2',
        taskQueue: 'test-queue-2',
      })

      await new Promise((r) => setTimeout(r, 3000))
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

  it('processes stripe_event signals in live phase', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-4',
      workflowsPath,
      activities: stubActivities(),
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'test-sync-4',
        taskQueue: 'test-queue-4',
      })

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
    })
  })

  it('triggers teardown on delete during backfill', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'test-queue-5',
      workflowsPath,
      activities: stubActivities({
        backfillPage: async () => {
          // Slow backfill so delete arrives mid-backfill
          await new Promise((r) => setTimeout(r, 500))
          return emptyResult
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
    })
  })
})
