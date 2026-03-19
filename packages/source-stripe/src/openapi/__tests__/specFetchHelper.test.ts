import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveOpenApiSpec } from '../specFetchHelper'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

describe('resolveOpenApiSpec', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prefers explicit local spec path over cache and network', async () => {
    const tempDir = await createTempDir('openapi-explicit')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      openApiSpecPath: specPath,
      cacheDir: tempDir,
    })

    expect(result.source).toBe('explicit_path')
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('uses cache by api version when available', async () => {
    const tempDir = await createTempDir('openapi-cache')
    const cachePath = path.join(tempDir, '2020-08-27.spec3.json')
    await fs.writeFile(cachePath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('cache')
    expect(result.cachePath).toBe(cachePath)
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fetches from GitHub when cache misses and persists cache', async () => {
    const tempDir = await createTempDir('openapi-fetch')
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = String(input)
      if (url.includes('/commits')) {
        return new Response(JSON.stringify([{ sha: 'abc123def456' }]), { status: 200 })
      }
      return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveOpenApiSpec({
      apiVersion: '2020-08-27',
      cacheDir: tempDir,
    })

    expect(result.source).toBe('github')
    expect(result.commitSha).toBe('abc123def456')

    const cached = await fs.readFile(path.join(tempDir, '2020-08-27.spec3.json'), 'utf8')
    expect(JSON.parse(cached)).toMatchObject({ openapi: '3.0.0' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('throws for malformed explicit spec files', async () => {
    const tempDir = await createTempDir('openapi-malformed')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify({ openapi: '3.0.0' }), 'utf8')

    await expect(
      resolveOpenApiSpec({
        apiVersion: '2020-08-27',
        openApiSpecPath: specPath,
      })
    ).rejects.toThrow(/components|schemas/i)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fails fast when GitHub resolution fails and no explicit spec path is set', async () => {
    const tempDir = await createTempDir('openapi-fail-fast')
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      resolveOpenApiSpec({
        apiVersion: '2020-08-27',
        cacheDir: tempDir,
      })
    ).rejects.toThrow(/Failed to resolve Stripe OpenAPI commit/)
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
