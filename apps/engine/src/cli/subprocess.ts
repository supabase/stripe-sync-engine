import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'

export interface ServeSubprocess {
  port: number
  url: string
  child: ChildProcess
  logFd: number
  kill(): void
}

/**
 * Spawn `sync-engine serve` as a child process on a random available port.
 * stdout and stderr are piped to `logFile`. Returns when the server is ready.
 */
export async function spawnServeSubprocess(
  logFile = 'sync-engine.log'
): Promise<ServeSubprocess> {
  const port = await getAvailablePort()
  const logFd = openSync(logFile, 'w')
  const child = spawn(
    process.execPath,
    // --conditions bun: resolve workspace packages to src/*.ts (requires tsx).
    // In production, use the compiled binary (sync-engine-serve) instead of this subprocess.
    ['--use-env-proxy', '--conditions', 'bun', '--import', 'tsx', 'apps/engine/src/bin/serve.ts'],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', logFd, logFd],
    }
  )
  child.on('error', (err) => {
    throw new Error(`Failed to spawn engine server: ${err.message}`)
  })
  const url = `http://localhost:${port}`
  await waitForServer(url)
  return {
    port,
    url,
    child,
    logFd,
    kill() {
      child.kill()
      closeSync(logFd)
    },
  }
}

/** Find an available TCP port by briefly binding to port 0. */
export async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const { port } = srv.address() as AddressInfo
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

/** Poll the server's /health endpoint until it responds or timeout. */
export async function waitForServer(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Engine server at ${url} did not start within ${timeoutMs}ms`)
}
