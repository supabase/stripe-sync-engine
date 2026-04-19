import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Bundled edge function code quality
// ---------------------------------------------------------------------------

// edge-function-code exports use ?raw Deno imports that are only available
// inside the esbuild bundle (build.mjs), not from dist/index.js.
// These tests need a separate bundle entry point to work.
describe.skip('Bundled edge function code', () => {
  let setupCode: string
  let webhookCode: string
  let syncCode: string

  beforeAll(async () => {
    const distPath = resolve(import.meta.dirname, '../../dist/index.js')
    const mod = await import(distPath)
    setupCode = mod.setupFunctionCode
    webhookCode = mod.webhookFunctionCode
    syncCode = mod.syncFunctionCode
  })

  it('setup edge function is bundled', () => {
    expect(setupCode).toBeTruthy()
  })

  it('webhook edge function is bundled', () => {
    expect(webhookCode).toBeTruthy()
  })

  it('sync edge function is bundled', () => {
    expect(syncCode).toBeTruthy()
  })

  it('setup code contains Deno.serve entry point', () => {
    expect(setupCode).toContain('Deno.serve')
  })

  it('webhook code contains Deno.serve entry point', () => {
    expect(webhookCode).toContain('Deno.serve')
  })

  it('sync code contains Deno.serve entry point', () => {
    expect(syncCode).toContain('Deno.serve')
  })

  it.todo(
    'bundled code does not reference private workspace packages — ' +
      'npm:@stripe/* must be inlined, not left as external imports'
  )
})
