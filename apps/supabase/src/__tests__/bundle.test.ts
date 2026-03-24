import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Bundled edge function code quality
// ---------------------------------------------------------------------------

describe.concurrent('Bundled edge function code', () => {
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
      'npm:@tx-stripe/* must be inlined, not left as external imports'
  )
})
