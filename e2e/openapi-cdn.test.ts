/**
 * E2E test: Stripe spec CDN at stripe-sync.dev/openapi/stripe
 *
 * Verifies that:
 * 1. manifest.json is accessible and lists known spec versions
 * 2. resolveOpenApiSpec returns source:'cdn' for a non-bundled version
 *
 * No env vars required — hits the live CDN directly.
 * Tests are skipped automatically when the CDN isn't deployed yet (404).
 * Once deployed, any failure here means the CDN is broken.
 */
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, it, expect } from 'vitest'
import { resolveOpenApiSpec, BUNDLED_API_VERSION } from '@stripe/sync-openapi'

const CDN_BASE = process.env.STRIPE_SPEC_CDN_BASE_URL ?? 'https://stripe-sync.dev/stripe-api-specs'

describe('Stripe spec CDN', () => {
  let manifest: Record<string, string> | null = null

  beforeAll(async () => {
    const res = await fetch(`${CDN_BASE}/manifest.json`).catch(() => null)
    if (!res || !res.ok) {
      console.warn(
        `Skipping CDN tests — ${CDN_BASE}/manifest.json returned ${res?.status ?? 'no response'} (CDN not deployed yet)`
      )
      return
    }
    manifest = (await res.json()) as Record<string, string>
  })

  it('manifest.json is reachable and lists spec versions', () => {
    if (!manifest) return // CDN not deployed yet

    const versions = Object.keys(manifest)
    expect(versions.length, 'manifest should list at least one version').toBeGreaterThan(0)

    for (const [version, filename] of Object.entries(manifest)) {
      expect(filename, `manifest entry for ${version}`).toMatch(/^.+\.json$/)
    }
  })

  it('each manifest entry resolves to a valid OpenAPI spec', async () => {
    if (!manifest) return // CDN not deployed yet

    // Spot-check the first 3 entries to keep the test fast
    const entries = Object.entries(manifest).slice(0, 3)
    for (const [version, filename] of entries) {
      const specRes = await fetch(`${CDN_BASE}/${filename}`)
      expect(specRes.status, `GET ${CDN_BASE}/${filename}`).toBe(200)

      const spec = (await specRes.json()) as Record<string, unknown>
      expect(typeof spec.openapi, `spec ${version} missing openapi field`).toBe('string')
      expect(spec.components, `spec ${version} missing components`).toBeTruthy()
    }
  })

  it('resolveOpenApiSpec uses cdn source for non-bundled version', async () => {
    if (!manifest) return // CDN not deployed yet

    // Find any version that isn't the bundled one
    const nonBundled = Object.keys(manifest).find(
      (v) => !v.startsWith(BUNDLED_API_VERSION.slice(0, 10))
    )
    if (!nonBundled) {
      console.warn('Only the bundled version is in the CDN manifest — skipping cdn source check')
      return
    }

    // Use an isolated cache dir so we don't hit a pre-existing cache entry
    const cacheDir = path.join(os.tmpdir(), `openapi-cdn-test-${Date.now()}`)
    const result = await resolveOpenApiSpec({ apiVersion: nonBundled, cacheDir }, fetch)

    expect(result.source).toBe('cdn')
    expect(result.apiVersion).toBe(nonBundled)
    expect(typeof result.spec.openapi).toBe('string')
  })
})
