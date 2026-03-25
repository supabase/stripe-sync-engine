import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { TestWorkflowEnvironment } from '@temporalio/testing'
import { Worker } from '@temporalio/worker'
import * as http from 'node:http'
import path from 'node:path'
import type { SyncActivities } from '../types'

const workflowsPath = path.resolve(process.cwd(), 'dist/workflows.js')

/**
 * Spin up a mock HTTP server that serves the 3-activity endpoints.
 * /sync streams NDJSON state messages with configurable delay.
 */
function createMockServer(opts: { streamCount: number; delayMs: number; complete?: boolean }): {
  server: http.Server
  start: () => Promise<string>
} {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`)

    if (url.pathname === '/setup' || url.pathname === '/teardown') {
      res.writeHead(200)
      res.end()
      return
    }

    if (url.pathname === '/sync') {
      // Stream NDJSON state messages
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      let i = 0

      function sendNext() {
        if (i >= opts.streamCount) {
          res.end()
          return
        }
        const msg = JSON.stringify({
          type: 'state',
          stream: `stream_${i}`,
          data: opts.complete ? { status: 'complete', cursor: i + 1 } : { cursor: i + 1 },
        })
        res.write(msg + '\n')
        i++
        setTimeout(sendNext, opts.delayMs)
      }

      sendNext()
      return
    }

    res.writeHead(404)
    res.end()
  })

  return {
    server,
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
    // 10 state messages, 500ms apart = 5s total
    mockServer = createMockServer({ streamCount: 10, delayMs: 500, complete: true })
    engineUrl = await mockServer.start()
  }, 120_000)

  afterAll(async () => {
    mockServer.server.close()
    await testEnv?.teardown()
  })

  it('sync activity streams NDJSON and heartbeats prevent timeout', async () => {
    const { createActivities } = await import('../activities')
    const realActivities = createActivities(engineUrl)

    // Use real sync activity, stub setup/teardown
    const activities: SyncActivities = {
      setup: async () => {},
      sync: realActivities.sync,
      teardown: async () => {},
    }

    const config = {
      source_name: 'stripe',
      destination_name: 'postgres',
      source_config: {},
      destination_config: {},
      streams: Array.from({ length: 10 }, (_, i) => ({ name: `stream_${i}` })),
    }

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: 'stream-test-1',
      workflowsPath,
      activities,
    })

    // 10 messages * 500ms = 5s total streaming time.
    // heartbeatTimeout of 2m means this should complete fine.
    // The key test is that streaming doesn't buffer the entire response.
    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start('syncWorkflow', {
        args: [config],
        workflowId: 'stream-test-1',
        taskQueue: 'stream-test-1',
      })

      // Wait for backfill to complete (sync returns all_complete: true), then delete in live
      await new Promise((r) => setTimeout(r, 8000))
      await handle.signal('delete')
      await handle.result()
    })

    // If we get here without a heartbeat timeout, the test passes.
  }, 30_000)

  it('sync activity forwards input events as NDJSON body', async () => {
    let receivedBody = ''

    // Custom server that captures the request body
    const captureServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`)

      if (url.pathname === '/setup' || url.pathname === '/teardown') {
        res.writeHead(200)
        res.end()
        return
      }

      if (url.pathname === '/sync') {
        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })
        req.on('end', () => {
          receivedBody = body
          // Return a complete state
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
          res.write(
            JSON.stringify({
              type: 'state',
              stream: 'customers',
              data: { status: 'complete' },
            }) + '\n'
          )
          res.end()
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    const captureUrl = await new Promise<string>((resolve) => {
      captureServer.listen(0, '127.0.0.1', () => {
        const addr = captureServer.address() as { port: number }
        resolve(`http://127.0.0.1:${addr.port}`)
      })
    })

    try {
      const { createActivities } = await import('../activities')
      const activities = createActivities(captureUrl)

      const config = {
        source_name: 'stripe',
        destination_name: 'postgres',
        source_config: {},
        destination_config: {},
        streams: [{ name: 'customers' }],
      }

      const events = [
        { id: 'evt_1', type: 'customer.created' },
        { id: 'evt_2', type: 'product.updated' },
      ]

      const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: 'stream-test-2',
        workflowsPath,
        activities: {
          setup: async () => {},
          // Call sync directly with input
          sync: activities.sync,
          teardown: async () => {},
        },
      })

      await worker.runUntil(async () => {
        const handle = await testEnv.client.workflow.start('syncWorkflow', {
          args: [{ ...config, phase: 'live' as const }],
          workflowId: 'stream-test-2',
          taskQueue: 'stream-test-2',
        })

        // Signal events to trigger live sync with input
        await new Promise((r) => setTimeout(r, 500))
        for (const event of events) {
          await handle.signal('stripe_event', event)
        }
        await new Promise((r) => setTimeout(r, 3000))
        await handle.signal('delete')
        await handle.result()
      })

      // Verify the request body was NDJSON
      const lines = receivedBody.trim().split('\n')
      expect(lines.length).toBe(2)
      expect(JSON.parse(lines[0])).toEqual(expect.objectContaining({ id: 'evt_1' }))
      expect(JSON.parse(lines[1])).toEqual(expect.objectContaining({ id: 'evt_2' }))
    } finally {
      captureServer.close()
    }
  }, 30_000)
})
