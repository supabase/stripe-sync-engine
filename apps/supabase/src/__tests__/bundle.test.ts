import { resolve } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Bundled edge function code quality
// ---------------------------------------------------------------------------

describe.concurrent('Bundled edge function code', () => {
  let syncCode: string

  beforeAll(async () => {
    const distPath = resolve(import.meta.dirname, '../../dist/index.js')
    const mod = await import(distPath)
    syncCode = mod.syncFunctionCode
  })

  it('consolidated edge function is bundled', () => {
    expect(syncCode).toBeTruthy()
  })

  it('bundled code contains Deno.serve entry point', () => {
    expect(syncCode).toContain('Deno.serve')
  })

  it.todo(
    'bundled code does not reference private workspace packages — ' +
      'npm:@stripe/* must be inlined, not left as external imports'
  )
})
