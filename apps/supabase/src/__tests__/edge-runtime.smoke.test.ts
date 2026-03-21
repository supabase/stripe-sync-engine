import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Edge-runtime container lifecycle
// ---------------------------------------------------------------------------

let containerId: string
let functionsDir: string
const PORT = 19000

beforeAll(async () => {
  functionsDir = mkdtempSync(join(tmpdir(), 'edge-runtime-smoke-'))

  // Deploy a minimal Deno function to validate the runtime
  const mainDir = join(functionsDir, 'main')
  mkdirSync(mainDir, { recursive: true })
  writeFileSync(
    join(mainDir, 'index.ts'),
    `Deno.serve((req) => {
      if (req.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 })
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    })`
  )

  containerId = execSync(
    [
      'docker run -d --rm',
      `-p ${PORT}:9000`,
      `-v ${functionsDir}:/home/deno/functions`,
      'supabase/edge-runtime:v1.71.2',
      'start --main-service /home/deno/functions/main',
    ].join(' '),
    { encoding: 'utf8' }
  ).trim()

  // Wait for the runtime to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Edge runtime did not become ready in time')
}, 60_000)

afterAll(() => {
  if (containerId) {
    try {
      execSync(`docker rm -f ${containerId}`)
    } catch {
      // container may have already exited with --rm
    }
  }
  if (functionsDir) {
    rmSync(functionsDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Runtime smoke tests
// ---------------------------------------------------------------------------

describe('Supabase edge-runtime smoke', () => {
  it('serves a Deno function via HTTP', async () => {
    const res = await fetch(`http://localhost:${PORT}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('function handles method routing', async () => {
    const res = await fetch(`http://localhost:${PORT}`, { method: 'POST' })
    expect(res.status).toBe(405)
  })
})

// ---------------------------------------------------------------------------
// Bundled edge function code quality
// ---------------------------------------------------------------------------

describe('Bundled edge function code', () => {
  let webhookCode: string
  let setupCode: string
  let workerCode: string
  let backfillWorkerCode: string

  beforeAll(async () => {
    const distPath = resolve(import.meta.dirname, '../../dist/index.js')
    const mod = await import(distPath)
    webhookCode = mod.webhookFunctionCode
    setupCode = mod.setupFunctionCode
    workerCode = mod.workerFunctionCode
    backfillWorkerCode = mod.backfillWorkerFunctionCode
  })

  it('all four edge functions are bundled', () => {
    expect(webhookCode).toBeTruthy()
    expect(setupCode).toBeTruthy()
    expect(workerCode).toBeTruthy()
    expect(backfillWorkerCode).toBeTruthy()
  })

  it('bundled code contains Deno.serve entry point', () => {
    for (const code of [webhookCode, setupCode, workerCode, backfillWorkerCode]) {
      expect(code).toContain('Deno.serve')
    }
  })

  it.todo(
    'bundled code does not reference private workspace packages — ' +
      'npm:@stripe/* must be inlined, not left as external imports'
  )
})
