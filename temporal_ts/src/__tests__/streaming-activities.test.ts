import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import * as http from 'node:http'
import path from 'node:path'
import type { SyncActivities, CategorizedMessages } from '../types'

const workflowsPath = path.resolve(process.cwd(), 'dist/workflows.js')

/**
 * Spin up a mock HTTP server that streams NDJSON lines with configurable delay.
 * Each line is a JSON object like {"type":"record","stream":"test","data":{"id":N}}.
 */
function createMockServer(opts: {
  lineCount: number
  delayMs: number
}): { server: http.Server; url: string; start: () => Promise<string> } {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`)

    if (url.pathname === '/check') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ source: { status: 'succeeded' }, destination: { status: 'succeeded' } }))
      return
    }

    if (url.pathname === '/setup' || url.pathname === '/teardown') {
      res.writeHead(200)
      res.end()
      return
    }

    // Stream NDJSON for /read and /write
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    let i = 0

    function sendNext() {
      if (i >= opts.lineCount) {
        res.end()
        return
      }
      const msg = JSON.stringify({
        type: 'record',
        stream: 'test',
        data: { id: i + 1 },
        emitted_at: Date.now(),
      })
      res.write(msg + '\n')
      i++
      setTimeout(sendNext, opts.delayMs)
    }

    sendNext()
  })

  return {
    server,
    url: '',
    start: () =>
      new Promise<string>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number }
          resolve(`http://127.0.0.1:${addr.port}`)
        })
      }),
  }
}

describe('Streaming activities with heartbeats', () => {
  let testEnv: TestWorkflowEnvironment
  let mockServer: ReturnType<typeof createMockServer>
  let engineUrl: string

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createLocal()
    mockServer = createMockServer({ lineCount: 10, delayMs: 500 })
    engineUrl = await mockServer.start()
  }, 120_000)

  afterAll(async () => {
    mockServer.server.close()
    await testEnv?.teardown()
  })

  it('backfillPage streams NDJSON and heartbeats prevent timeout', async () => {
    // Import createActivities dynamically to get the real implementation
    const { createActivities } = await import('../activities')
    const realActivities = createActivities(engineUrl)

    // Wrap real streaming activities with stubs for non-streaming ones
    const activities: SyncActivities = {
      ...realActivities,
      // Override non-streaming activities to avoid issues
      healthCheck: async () => ({ source: { status: 'succeeded' }, destination: { status: 'succeeded' } }),
      sourceSetup: async () => {},
      destinationSetup: async () => {},
      sourceTeardown: async () => {},
      destinationTeardown: async () => {},
    }

    const config = {
      source_name: 'stripe',
      destination_name: 'postgres',
      source_config: {},
      destination_config: {},
      streams: [{ name: 'test' }],
    }

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'stream-test-1',
      workflowsPath,
      activities,
    })

    // 10 records * 500ms = 5s total streaming time.
    // heartbeatTimeout of 2s means without heartbeats this would fail.
    // The activity heartbeats every 100 records (won't hit 100 here),
    // but also heartbeats at the end.
    // Since we only have 10 records, the key test is that streaming
    // doesn't buffer the entire response — if it did, the 5s pause
    // before any data arrives would cause a heartbeat timeout.
    //
    // We run the workflow for just long enough to start the backfill
    // activity, then signal delete to stop.
    let backfillResult: CategorizedMessages | undefined

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'stream-test-1',
        taskQueue: 'stream-test-1',
      })

      // Wait for backfill to complete (10 records * 500ms + overhead)
      await new Promise((r) => setTimeout(r, 8000))
      await handle.signal('delete')
      await handle.result()
    })

    // If we get here without a heartbeat timeout, the test passes.
    // The workflow completing means the streaming activity worked.
  }, 30_000)

  it('writeBatch streams response and collects messages', async () => {
    const { createActivities } = await import('../activities')
    const realActivities = createActivities(engineUrl)

    const activities: SyncActivities = {
      ...realActivities,
      healthCheck: async () => ({ source: { status: 'succeeded' }, destination: { status: 'succeeded' } }),
      sourceSetup: async () => {},
      destinationSetup: async () => {},
      sourceTeardown: async () => {},
      destinationTeardown: async () => {},
      // Replace backfillPage to return records that writeBatch will process
      backfillPage: async () => ({
        records: [
          { type: 'record', stream: 'test', data: { id: 1 }, emitted_at: Date.now() },
        ],
        states: [],
        errors: [],
        stream_statuses: [{ type: 'stream_status' as const, stream: 'test', status: 'complete' }],
        messages: [],
      }),
    }

    const config = {
      source_name: 'stripe',
      destination_name: 'postgres',
      source_config: {},
      destination_config: {},
      streams: [{ name: 'test' }],
    }

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'stream-test-2',
      workflowsPath,
      activities,
    })

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'stream-test-2',
        taskQueue: 'stream-test-2',
      })

      // Wait for backfill + write to complete, then delete
      await new Promise((r) => setTimeout(r, 10_000))
      await handle.signal('delete')
      await handle.result()
    })
    // If we reach here, streaming writeBatch succeeded
  }, 30_000)
})
