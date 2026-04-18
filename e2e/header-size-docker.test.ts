import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { BUNDLED_API_VERSION } from '@stripe/sync-openapi'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_NODE_MAX_HEADER_SIZE = 16 * 1024
const TEST_HEADER_SIZE = 20 * 1024

interface MockStripeServer {
  url: string
  close: () => Promise<void>
}

interface EngineContainer {
  url: string
  logs: () => Promise<string>
  kill: () => Promise<void>
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    allowFailure?: boolean
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      if (exitCode === 0 || options.allowFailure) {
        resolve({ stdout, stderr, exitCode })
        return
      }

      reject(
        new Error(
          [`Command failed: ${command} ${args.join(' ')}`, stdout.trim(), stderr.trim()]
            .filter(Boolean)
            .join('\n\n')
        )
      )
    })
  })
}

async function hasDocker(): Promise<boolean> {
  try {
    await runCommand('docker', ['info'])
    return true
  } catch {
    return false
  }
}

function getPort(): number {
  return 10_000 + Math.floor(Math.random() * 50_000)
}

async function getContainerLogs(containerName: string): Promise<string> {
  const result = await runCommand('docker', ['logs', containerName], { allowFailure: true })
  return `${result.stdout}${result.stderr}`.trim()
}

async function removeContainer(containerName: string): Promise<void> {
  await runCommand('docker', ['rm', '-f', containerName], { allowFailure: true })
}

async function startMockStripeApi(): Promise<MockStripeServer> {
  let serverRef: Server | null = null

  const url = await new Promise<string>((resolve) => {
    serverRef = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost')

      if (requestUrl.pathname === '/v1/account') {
        const body = JSON.stringify({
          id: 'acct_test_mock',
          object: 'account',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        })
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Content-Length', Buffer.byteLength(body))
        res.end(body)
        return
      }

      res.statusCode = 404
      res.end('not_found')
    })

    serverRef.listen(0, '0.0.0.0', () => {
      resolve(`http://localhost:${(serverRef!.address() as AddressInfo).port}`)
    })
  })

  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        serverRef?.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

function dockerVisibleUrl(url: string): string {
  const normalized = new URL(url)
  if (normalized.hostname === 'localhost' || normalized.hostname === '127.0.0.1') {
    normalized.hostname = 'host.docker.internal'
  }
  return normalized.toString()
}

function makePipelineHeader(targetBytes: number, mockStripeUrl: string): string {
  const base = {
    source: {
      type: 'stripe',
      stripe: {
        api_key: 'sk_test_fake',
        api_version: BUNDLED_API_VERSION,
        base_url: mockStripeUrl,
      },
    },
    destination: {
      type: 'postgres',
      postgres: {
        connection_string: 'postgres://user:pass@127.0.0.1:1/testdb',
        schema: 'header_size_test',
      },
    },
    streams: [{ name: 'customers' }],
    _padding: '',
  }

  const shellSize = Buffer.byteLength(JSON.stringify(base))
  base._padding = 'x'.repeat(Math.max(0, targetBytes - shellSize))
  return JSON.stringify(base)
}

async function waitForServer(url: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`Server at ${url} did not become healthy in ${timeout}ms`)
}

async function startEngineDocker(port: number): Promise<EngineContainer> {
  const image = process.env.ENGINE_IMAGE ?? 'sync-engine:header-size-test'
  const containerName = `header-size-test-${port}`

  if (!process.env.ENGINE_IMAGE) {
    await runCommand('docker', ['build', '--target', 'engine', '-t', image, '.'], {
      cwd: REPO_ROOT,
    })
  }

  try {
    await runCommand(
      'docker',
      [
        'run',
        '-d',
        '--name',
        containerName,
        '-p',
        `${port}:3000`,
        '--add-host',
        'host.docker.internal:host-gateway',
        image,
      ],
      {
        cwd: REPO_ROOT,
      }
    )
    await waitForServer(`http://localhost:${port}`)
  } catch (error) {
    const logs = await getContainerLogs(containerName)
    await removeContainer(containerName)
    throw new Error(`Failed to start engine container.\n\n${logs || String(error)}`)
  }

  return {
    url: `http://localhost:${port}`,
    logs: () => getContainerLogs(containerName),
    kill: () => removeContainer(containerName),
  }
}

describe('docker serve header size', () => {
  let mockStripe: MockStripeServer
  let engine: EngineContainer

  beforeAll(async () => {
    if (!(await hasDocker())) {
      throw new Error('Docker is required for header-size docker e2e tests')
    }

    mockStripe = await startMockStripeApi()
    engine = await startEngineDocker(getPort())
  }, 180_000)

  afterAll(async () => {
    await engine?.kill()
    await mockStripe?.close()
  })

  it('accepts a pipeline header larger than Node default when run via the serve binary', async () => {
    const pipelineHeader = makePipelineHeader(TEST_HEADER_SIZE, dockerVisibleUrl(mockStripe.url))
    expect(Buffer.byteLength(pipelineHeader)).toBeGreaterThan(DEFAULT_NODE_MAX_HEADER_SIZE)

    const res = await fetch(`${engine.url}/pipeline_check`, {
      method: 'POST',
      headers: { 'X-Pipeline': pipelineHeader },
    })
    const body = await res.text()
    const logs = res.status === 200 ? '' : await engine.logs()

    expect(res.status, logs).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(body).toContain('"type":"connection_status"')
  }, 30_000)
})
