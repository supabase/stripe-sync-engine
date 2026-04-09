import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveOpenApiSpec } from '../specFetchHelper'
import { minimalStripeOpenApiSpec } from './fixtures/minimalSpec'

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

// Mock fetch that returns 404 for CDN URLs (not deployed in tests) and
// handles GitHub API calls normally.
function makeFetchMock(
  githubHandler: (url: string) => Response | Promise<Response>
): typeof globalThis.fetch {
  return vi.fn(async (input: URL | string) => {
    const url = String(input)
    if (url.includes('stripe-sync.dev')) {
      return new Response('not found', { status: 404 })
    }
    return githubHandler(url)
  }) as unknown as typeof globalThis.fetch
}

describe('resolveOpenApiSpec', () => {
  it('prefers explicit local spec path over cache and network', async () => {
    const tempDir = await createTempDir('openapi-explicit')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch should not be called'))

    const result = await resolveOpenApiSpec(
      {
        apiVersion: '2020-08-27',
        openApiSpecPath: specPath,
        cacheDir: tempDir,
      },
      fetchMock
    )

    expect(result.source).toBe('explicit_path')
    expect(result.spec.paths?.['/v1/recipients']).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('uses cache by api version when available', async () => {
    const tempDir = await createTempDir('openapi-cache')
    const cachePath = path.join(tempDir, '2020-08-27.spec3.sdk.json')
    await fs.writeFile(cachePath, JSON.stringify(minimalStripeOpenApiSpec), 'utf8')
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch should not be called'))

    const result = await resolveOpenApiSpec(
      {
        apiVersion: '2020-08-27',
        cacheDir: tempDir,
      },
      fetchMock
    )

    expect(result.source).toBe('cache')
    expect(result.cachePath).toBe(cachePath)
    expect(result.spec.paths?.['/v1/recipients']).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fetches from GitHub when cache misses and persists cache', async () => {
    const tempDir = await createTempDir('openapi-fetch')
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('/commits')) {
        return new Response(JSON.stringify([{ sha: 'abc123def456' }]), { status: 200 })
      }
      return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
    })

    const result = await resolveOpenApiSpec(
      {
        apiVersion: '2020-08-27',
        cacheDir: tempDir,
      },
      fetchMock
    )

    expect(result.source).toBe('github')
    expect(result.commitSha).toBe('abc123def456')
    expect(result.spec.paths?.['/v1/recipients']).toBeUndefined()

    const cached = await fs.readFile(path.join(tempDir, '2020-08-27.spec3.sdk.json'), 'utf8')
    expect(JSON.parse(cached)).toMatchObject({ openapi: '3.0.0' })
    expect(JSON.parse(cached).paths['/v1/recipients']).toBeUndefined()
    // 1 CDN manifest (404) + 1 GitHub commits + 1 GitHub spec
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('uses the injected fetch for GitHub fetches', async () => {
    const tempDir = await createTempDir('openapi-fetch-proxy')
    const fetchMock = makeFetchMock((url) => {
      if (url.includes('/commits')) {
        return new Response(JSON.stringify([{ sha: 'abc123def456' }]), { status: 200 })
      }
      return new Response(JSON.stringify(minimalStripeOpenApiSpec), { status: 200 })
    })
    try {
      const result = await resolveOpenApiSpec(
        { apiVersion: '2020-08-27', cacheDir: tempDir },
        fetchMock
      )
      expect(result.source).toBe('github')
      // 1 CDN manifest (404) + 1 GitHub commits + 1 GitHub spec
      expect(fetchMock).toHaveBeenCalledTimes(3)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('throws for malformed explicit spec files', async () => {
    const tempDir = await createTempDir('openapi-malformed')
    const specPath = path.join(tempDir, 'spec3.json')
    await fs.writeFile(specPath, JSON.stringify({ openapi: '3.0.0' }), 'utf8')

    await expect(
      resolveOpenApiSpec(
        {
          apiVersion: '2020-08-27',
          openApiSpecPath: specPath,
        },
        vi.fn().mockRejectedValue(new Error('fetch should not be called'))
      )
    ).rejects.toThrow(/components|schemas/i)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('fails fast when GitHub resolution fails and no explicit spec path is set', async () => {
    const tempDir = await createTempDir('openapi-fail-fast')
    // CDN returns 500 → tryFetchFromCdn returns null → falls through to GitHub (500) → throws
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }))

    await expect(
      resolveOpenApiSpec(
        {
          apiVersion: '2020-08-27',
          cacheDir: tempDir,
        },
        fetchMock
      )
    ).rejects.toThrow(/Failed to resolve Stripe OpenAPI commit/)
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
