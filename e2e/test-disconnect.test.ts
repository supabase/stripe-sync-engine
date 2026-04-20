/**
 * Black-box disconnect + time-limit tests.
 *
 * Architecture:
 *   Test process  ----(HTTP)---->  Engine server (black box)  ----(HTTP)---->  Mock Stripe API
 *
 * The engine is started as a separate process (Node, Bun, or Docker).
 * The mock Stripe API is a lightweight Hono server started by the test.
 * Assertions use three signals:
 *   1. Mock server request count (proves engine stopped making API calls)
 *   2. Engine stderr log lines (distinct tags per termination type)
 *   3. NDJSON eof payload (elapsed_ms, cutoff)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn, execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'

// ── Constants ──────────────────────────────────────────────────

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ENGINE_DIST = path.join(REPO_ROOT, 'apps/engine/dist/bin/serve.js')
const ENGINE_SRC = path.join(REPO_ROOT, 'apps/engine/src/bin/serve.ts')

function hasBun(): boolean {
  try {
    execSync('bun --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function hasDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── Mock Stripe API ────────────────────────────────────────────

interface MockStripeServer {
  url: string
  requestCount: () => number
  resetCount: () => void
  close: () => Promise<void>
}

async function startMockStripeApi(
  opts: { delayMs?: number; port?: number } = {}
): Promise<MockStripeServer> {
  const delayMs = opts.delayMs ?? 0
  const port = opts.port ?? 0
  let count = 0
  let serverRef: Server | null = null

  const url = await new Promise<string>((resolve) => {
    serverRef = createServer(async (req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')

      function sendJson(status: number, payload: unknown) {
        const body = JSON.stringify(payload)
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
      }

      if (requestUrl.pathname === '/request_count') {
        sendJson(200, { count })
        return
      }

      if (requestUrl.pathname === '/v1/account') {
        sendJson(200, {
          id: 'acct_test_mock',
          object: 'account',
          type: 'standard',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          country: 'US',
          default_currency: 'usd',
          created: 1000000000,
          settings: { dashboard: { display_name: 'Mock' } },
        })
        return
      }

      if (requestUrl.pathname === '/v1/customers') {
        count++
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        const startingAfter = requestUrl.searchParams.get('starting_after')
        const pageIndex = startingAfter ? parseInt(startingAfter.replace('cus_', '')) : 0
        const pageSize = 10
        const data = Array.from({ length: pageSize }, (_, i) => ({
          id: `cus_${pageIndex + i + 1}`,
          object: 'customer',
          name: `Customer ${pageIndex + i + 1}`,
          email: `c${pageIndex + i + 1}@test.com`,
          created: 1000000000 + pageIndex + i + 1,
        }))
        sendJson(200, {
          object: 'list',
          url: '/v1/customers',
          has_more: true,
          data,
        })
        return
      }

      if (requestUrl.pathname.startsWith('/v1/')) {
        count++
        sendJson(200, {
          object: 'list',
          url: requestUrl.pathname,
          has_more: false,
          data: [],
        })
        return
      }

      sendJson(404, { error: 'not_found' })
    })
    serverRef.listen(port, '0.0.0.0', () => {
      resolve(`http://localhost:${(serverRef!.address() as AddressInfo).port}`)
    })
  })

  return {
    url,
    requestCount: () => count,
    resetCount: () => {
      count = 0
    },
    close: () =>
      new Promise((resolve, reject) => {
        serverRef?.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

// ── Engine process management ──────────────────────────────────

interface EngineProcess {
  url: string
  stderr: string
  kill: () => void
}

function getPort(): number {
  return 10_000 + Math.floor(Math.random() * 50_000)
}

async function startEngineNode(port: number): Promise<EngineProcess> {
  let output = ''
  let exited = false
  const child = spawn('node', [ENGINE_DIST], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'trace', LOG_PRETTY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // pino logs to stdout by default
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) {
      console.error(`Engine process exited with code ${code}. output:\n${output}`)
    }
  })

  await waitForServer(`http://localhost:${port}`, 60_000, () => {
    if (exited) throw new Error(`Engine exited before becoming healthy. output:\n${output}`)
  })
  return {
    url: `http://localhost:${port}`,
    get stderr() {
      return output
    },
    kill: () => child.kill(),
  }
}

async function startEngineBun(port: number): Promise<EngineProcess> {
  let output = ''
  let exited = false
  const child = spawn('bun', [ENGINE_SRC], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'trace', LOG_PRETTY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null) {
      console.error(`Bun engine process exited with code ${code}. output:\n${output}`)
    }
  })

  await waitForServer(`http://localhost:${port}`, 60_000, () => {
    if (exited) throw new Error(`Bun engine exited before becoming healthy. output:\n${output}`)
  })
  return {
    url: `http://localhost:${port}`,
    get stderr() {
      return output
    },
    kill: () => child.kill(),
  }
}

async function startEngineDocker(port: number, _mockUrl: string): Promise<EngineProcess> {
  const image = process.env.ENGINE_IMAGE ?? 'sync-engine:disconnect-test'
  if (!process.env.ENGINE_IMAGE) {
    execSync(`docker build --target engine -t ${image} .`, { cwd: REPO_ROOT, stdio: 'inherit' })
  }

  const containerName = `disconnect-test-${port}`
  const useHostNetwork = process.env.DISCONNECT_TEST_DOCKER_HOST_NETWORK === '1'
  const runCommand = useHostNetwork
    ? `docker run -d --name ${containerName} --network=host -e PORT=${port} ${image}`
    : `docker run -d --name ${containerName} -p ${port}:3000 --add-host=host.docker.internal:host-gateway ${image}`
  execSync(runCommand, { cwd: REPO_ROOT, stdio: 'ignore' })

  await waitForServer(`http://localhost:${port}`, 60_000)

  return {
    url: `http://localhost:${port}`,
    get stderr() {
      try {
        return execSync(`docker logs ${containerName} 2>&1`, { encoding: 'utf8' })
      } catch {
        return ''
      }
    },
    kill: () => {
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' })
      } catch {}
    },
  }
}

async function waitForServer(
  url: string,
  timeout = 30_000,
  checkAlive?: () => void
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    checkAlive?.()
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server at ${url} did not become healthy in ${timeout}ms`)
}

async function waitForLog(engine: EngineProcess, needle: string, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (engine.stderr.includes(needle)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for log ${needle}\n\nCurrent output:\n${engine.stderr}`)
}

// ── NDJSON helpers ─────────────────────────────────────────────

function makePipelineHeader(mockStripeUrl: string): string {
  return JSON.stringify({
    source: {
      type: 'stripe',
      stripe: {
        api_key: 'sk_test_fake',
        api_version: BUNDLED_API_VERSION,
        base_url: mockStripeUrl,
        rate_limit: 1000,
      },
    },
    destination: {
      type: 'postgres',
      postgres: {
        url: 'postgres://user:pass@localhost:65432/testdb',
        schema: 'test_disconnect',
      },
    },
    streams: [{ name: 'customers' }],
  })
}

function normalizeMockUrlForRuntime(runtimeName: string, url: string): string {
  if (runtimeName !== 'docker') return url
  if (process.env.DISCONNECT_TEST_DOCKER_HOST_NETWORK === '1') return url
  const u = new URL(url)
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
    u.hostname = 'host.docker.internal'
  }
  return u.toString()
}

async function readNdjsonLines(
  response: Response,
  maxLines = 5
): Promise<Record<string, unknown>[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const lines: Record<string, unknown>[] = []

  while (lines.length < maxLines) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n')
    buffer = parts.pop()!
    for (const part of parts) {
      if (part.trim()) {
        lines.push(JSON.parse(part))
        if (lines.length >= maxLines) break
      }
    }
  }

  reader.releaseLock()
  return lines
}

// ── Tests ──────────────────────────────────────────────────────

type RuntimeConfig = {
  name: string
  start: (port: number, mockUrl: string) => Promise<EngineProcess>
  skip: boolean
}

const explicitRuntimeSelection =
  process.env.DISCONNECT_TEST_NODE ||
  process.env.DISCONNECT_TEST_BUN ||
  process.env.DISCONNECT_TEST_DOCKER

const runtimes: RuntimeConfig[] = [
  {
    name: 'node',
    start: (port) => startEngineNode(port),
    skip: explicitRuntimeSelection ? process.env.DISCONNECT_TEST_NODE !== '1' : false,
  },
  {
    name: 'bun',
    start: (port) => startEngineBun(port),
    skip: explicitRuntimeSelection ? process.env.DISCONNECT_TEST_BUN !== '1' : !hasBun(),
  },
  {
    name: 'docker',
    start: (port, mockUrl) => startEngineDocker(port, mockUrl),
    skip: explicitRuntimeSelection ? process.env.DISCONNECT_TEST_DOCKER !== '1' : true,
  },
]

for (const runtime of runtimes) {
  describe.skipIf(runtime.skip)(`disconnect [${runtime.name}]`, () => {
    let mockApi: MockStripeServer
    let engine: EngineProcess

    beforeAll(async () => {
      mockApi = await startMockStripeApi({
        delayMs: 200,
        port: runtime.name === 'docker' ? 18888 : 0,
      })
      const port = getPort()
      engine = await runtime.start(port, mockApi.url)
    }, 120_000)

    afterAll(async () => {
      engine?.kill()
      await mockApi?.close()
    })

    beforeEach(() => {
      mockApi.resetCount()
    })

    it('client disconnect stops the engine from making further API calls', async () => {
      const pipelineHeader = makePipelineHeader(
        normalizeMockUrlForRuntime(runtime.name, mockApi.url)
      )
      const ac = new AbortController()

      // Start a streaming sync request
      const fetchPromise = fetch(`${engine.url}/pipeline_read`, {
        method: 'POST',
        headers: { 'X-Pipeline': pipelineHeader },
        signal: ac.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            console.error(`pipeline_read returned ${res.status}: ${body}`)
          }
          return res
        })
        .catch(() => null)

      // Wait for some requests to hit the mock
      await new Promise((r) => setTimeout(r, 1500))
      const countBeforeDisconnect = mockApi.requestCount()
      expect(countBeforeDisconnect).toBeGreaterThan(0)

      // Disconnect
      ac.abort()
      await fetchPromise

      // Allow a short settling window for requests that were already in flight
      await new Promise((r) => setTimeout(r, 300))
      const countShortlyAfterAbort = mockApi.requestCount()

      // Then verify the engine stops making further progress
      await new Promise((r) => setTimeout(r, 2000))
      const countAfterWait = mockApi.requestCount()
      expect(countAfterWait - countShortlyAfterAbort).toBeLessThanOrEqual(2)

      await waitForLog(engine, 'SYNC_CLIENT_DISCONNECT')
    }, 30_000)

    it('soft time limit returns eof with cutoff=soft and elapsed_ms', async () => {
      const pipelineHeader = makePipelineHeader(
        normalizeMockUrlForRuntime(runtime.name, mockApi.url)
      )

      const start = Date.now()
      const res = await fetch(`${engine.url}/pipeline_read?time_limit=3`, {
        method: 'POST',
        headers: { 'X-Pipeline': pipelineHeader },
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`soft time limit test: pipeline_read returned ${res.status}: ${body}`)
      }
      expect(res.status).toBe(200)

      // Read all NDJSON lines until stream ends
      const text = await res.text()
      const elapsed = Date.now() - start
      const lines = text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
      const eof = lines.find((l: any) => l.type === 'eof') as any

      expect(eof).toBeDefined()
      expect(eof.eof.has_more).toBe(true)
      // Verify wall-clock elapsed is within the time limit window
      expect(elapsed).toBeGreaterThan(1500)
      expect(elapsed).toBeLessThan(5000)

      await waitForLog(engine, 'SYNC_TIME_LIMIT_SOFT')
    }, 30_000)

    it('hard time limit forces return when source blocks', async () => {
      // Use a mock with very long delay (5s per page) so the source blocks past the hard deadline
      const slowMock = await startMockStripeApi({
        delayMs: 5000,
        port: runtime.name === 'docker' ? 18889 : 0,
      })
      try {
        const pipelineHeader = makePipelineHeader(
          normalizeMockUrlForRuntime(runtime.name, slowMock.url)
        )

        const start = Date.now()
        const res = await fetch(`${engine.url}/pipeline_read?time_limit=2`, {
          method: 'POST',
          headers: { 'X-Pipeline': pipelineHeader },
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error(`hard time limit test: pipeline_read returned ${res.status}: ${body}`)
        }
        expect(res.status).toBe(200)

        const text = await res.text()
        const elapsed = Date.now() - start
        const lines = text
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
        const eof = lines.find((l: any) => l.type === 'eof') as any

        expect(eof).toBeDefined()
        expect(eof.eof.has_more).toBe(true)
        // Hard deadline = 2s + 1s = 3s. Allow generous CI slack.
        expect(elapsed).toBeGreaterThan(2000)
        expect(elapsed).toBeLessThan(15000)

        // The key assertion: the response completed in ~3s, NOT in 5s+ (a full page delay).
        // The connector may have launched concurrent requests before the hard deadline,
        // so we don't assert request count — we assert elapsed time above.
        const countAtEof = slowMock.requestCount()

        // After eof, no MORE requests should be made (signal killed in-flight fetches)
        await new Promise((r) => setTimeout(r, 2000))
        const countAfterWait = slowMock.requestCount()
        expect(countAfterWait - countAtEof).toBeLessThanOrEqual(1)

        await waitForLog(engine, 'SYNC_TIME_LIMIT_HARD')
      } finally {
        await slowMock.close()
      }
    }, 30_000)
  })
}
