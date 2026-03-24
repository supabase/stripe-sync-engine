import { execSync, execFileSync } from 'child_process'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const IMAGE = 'sync-engine:docker-test'
const CONTAINER = 'sync-engine-docker-test'

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf-8', timeout: 10_000 }).trim()
}

describe('Docker image', { timeout: 180_000 }, () => {
  beforeAll(() => {
    execSync(`docker build -t ${IMAGE} .`, {
      cwd: process.cwd().replace(/apps\/sync-engine.*/, ''),
      stdio: 'inherit',
      timeout: 150_000,
    })
  }, 180_000)

  afterAll(() => {
    try {
      docker('rm', '-f', CONTAINER)
    } catch {}
  })

  it('--version prints version and exits', () => {
    const out = docker('run', '--rm', IMAGE, '--version')
    expect(out).toMatch(/\d+\.\d+\.\d+/)
  })

  it('--help prints usage and exits', () => {
    const out = docker('run', '--rm', IMAGE, '--help')
    expect(out).toContain('sync-engine')
    expect(out).toContain('serve')
    expect(out).toContain('sync')
    expect(out).toContain('check')
  })

  it('serve starts HTTP server with /health endpoint', async () => {
    // Start the container in background
    docker('run', '-d', '--name', CONTAINER, '-p', '13579:3000', IMAGE)

    // Wait for the server to be ready
    let healthy = false
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch('http://localhost:13579/health')
        if (res.ok) {
          const body = await res.json()
          expect(body).toEqual({ ok: true })
          healthy = true
          break
        }
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(healthy).toBe(true)

    // Cleanup — use -t 0 so docker stop sends SIGKILL immediately instead of
    // waiting 10 s for graceful shutdown (which races our execFileSync timeout).
    docker('stop', '-t', '0', CONTAINER)
  })

  it('check exits non-zero without valid config', () => {
    expect(() =>
      docker('run', '--rm', IMAGE, 'check', '--postgres-url', 'postgres://invalid:5432/db')
    ).toThrow()
  })
})
