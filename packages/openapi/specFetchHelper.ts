import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OpenApiSpec, ResolveSpecConfig, ResolvedOpenApiSpec } from './types.js'

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'stripe-sync-openapi-cache')

// CDN mirror of the official Stripe REST API specs (from github.com/stripe/openapi).
// Served from stripe-sync.dev — no auth, no GitHub rate limits.
// These are the upstream Stripe API specs, NOT the Sync Engine's own OpenAPI spec.
// Override with STRIPE_SPEC_CDN_BASE_URL env var (e.g. in tests or self-hosting).
const STRIPE_SPEC_CDN_BASE_URL =
  process.env.STRIPE_SPEC_CDN_BASE_URL ?? 'https://stripe-sync.dev/stripe-api-specs'

import { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS } from './src/versions.js'
export { BUNDLED_API_VERSION, SUPPORTED_API_VERSIONS }

export async function resolveOpenApiSpec(
  config: ResolveSpecConfig,
  fetch: typeof globalThis.fetch
): Promise<ResolvedOpenApiSpec> {
  const apiVersion = config.apiVersion
  if (!apiVersion || !/^\d{4}-\d{2}-\d{2}(\.\w+)?$/.test(apiVersion)) {
    throw new Error(
      `Invalid Stripe API version "${apiVersion}". Expected YYYY-MM-DD or YYYY-MM-DD.codename.`
    )
  }

  if (config.openApiSpecPath) {
    const explicitSpec = await readSpecFromPath(config.openApiSpecPath)
    return {
      apiVersion,
      spec: explicitSpec,
      source: 'explicit_path',
      cachePath: config.openApiSpecPath,
    }
  }

  // If the requested version matches what's bundled, serve from the filesystem
  // without any network calls or caching overhead.
  if (extractDatePart(apiVersion) === extractDatePart(BUNDLED_API_VERSION)) {
    const bundledPath = fileURLToPath(new URL(`./oas/${BUNDLED_API_VERSION}.json`, import.meta.url))
    const spec = await readSpecFromPath(bundledPath)
    return {
      apiVersion,
      spec,
      source: 'bundled',
      cachePath: bundledPath,
    }
  }

  const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR
  const cachePath = getCachePath(cacheDir, apiVersion)
  const cachedSpec = await tryReadCachedSpec(cachePath)
  if (cachedSpec) {
    return {
      apiVersion,
      spec: cachedSpec,
      source: 'cache',
      cachePath,
    }
  }

  // Try the Vercel CDN mirror before falling back to the GitHub API.
  // The CDN serves spec versions without auth or rate limits.
  const cdnSpec = await tryFetchFromCdn(apiVersion, fetch)
  if (cdnSpec) {
    await tryWriteCache(cachePath, cdnSpec)
    return {
      apiVersion,
      spec: cdnSpec,
      source: 'cdn',
      cachePath,
    }
  }

  let commitSha = await resolveCommitShaForApiVersion(apiVersion, fetch)
  if (!commitSha) {
    commitSha = await resolveLatestCommitSha(fetch)
  }
  if (!commitSha) {
    throw new Error(
      `Could not resolve Stripe OpenAPI commit for API version ${apiVersion} and no local spec path was provided.`
    )
  }

  const spec = await fetchSpecForCommit(commitSha, fetch)
  validateOpenApiSpec(spec)
  await tryWriteCache(cachePath, spec)

  return {
    apiVersion,
    spec,
    source: 'github',
    cachePath,
    commitSha,
  }
}

async function readSpecFromPath(openApiSpecPath: string): Promise<OpenApiSpec> {
  const raw = await fs.readFile(openApiSpecPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse OpenAPI spec at ${openApiSpecPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validateOpenApiSpec(parsed)
  return parsed
}

async function tryReadCachedSpec(cachePath: string): Promise<OpenApiSpec | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    validateOpenApiSpec(parsed)
    return parsed
  } catch {
    return null
  }
}

async function tryWriteCache(cachePath: string, spec: OpenApiSpec): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(spec), 'utf8')
  } catch {
    // Best effort only. Cache writes should never block migration flow.
  }
}

async function tryFetchFromCdn(
  apiVersion: string,
  fetch: typeof globalThis.fetch
): Promise<OpenApiSpec | null> {
  // The CDN manifest maps "YYYY-MM-DD.codename" → "YYYY-MM-DD.codename.json".
  // We match by date part so "2026-03-25" resolves to "2026-03-25.dahlia.json".
  if (!STRIPE_SPEC_CDN_BASE_URL) return null
  try {
    const manifestUrl = `${STRIPE_SPEC_CDN_BASE_URL}/manifest.json`
    const manifestRes = await fetch(manifestUrl)
    if (!manifestRes.ok) return null

    const manifest = (await manifestRes.json()) as Record<string, string>
    const datePart = extractDatePart(apiVersion)
    const filename = Object.keys(manifest).find((v) => extractDatePart(v) === datePart)
    if (!filename) return null

    const specUrl = `${STRIPE_SPEC_CDN_BASE_URL}/${manifest[filename]}`
    const specRes = await fetch(specUrl)
    if (!specRes.ok) return null

    const spec = (await specRes.json()) as unknown
    validateOpenApiSpec(spec)
    return spec
  } catch {
    return null
  }
}

function getCachePath(cacheDir: string, apiVersion: string): string {
  const safeVersion = apiVersion.replace(/[^0-9a-zA-Z_-]/g, '_')
  return path.join(cacheDir, `${safeVersion}.spec3.sdk.json`)
}

function extractDatePart(apiVersion: string): string {
  const match = apiVersion.match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : apiVersion
}

async function resolveLatestCommitSha(fetch: typeof globalThis.fetch): Promise<string | null> {
  const url = new URL('https://api.github.com/repos/stripe/openapi/commits')
  url.searchParams.set('path', 'latest/openapi.spec3.sdk.json')
  url.searchParams.set('per_page', '1')

  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(
      `Failed to resolve latest Stripe OpenAPI commit (${response.status} ${response.statusText})`
    )
  }

  const json = (await response.json()) as Array<{ sha?: string }>
  const commitSha = json[0]?.sha
  return typeof commitSha === 'string' && commitSha.length > 0 ? commitSha : null
}

async function resolveCommitShaForApiVersion(
  apiVersion: string,
  fetch: typeof globalThis.fetch
): Promise<string | null> {
  const until = `${extractDatePart(apiVersion)}T23:59:59Z`
  const url = new URL('https://api.github.com/repos/stripe/openapi/commits')
  url.searchParams.set('path', 'latest/openapi.spec3.sdk.json')
  url.searchParams.set('until', until)
  url.searchParams.set('per_page', '1')

  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(
      `Failed to resolve Stripe OpenAPI commit (${response.status} ${response.statusText})`
    )
  }

  const json = (await response.json()) as Array<{ sha?: string }>
  const commitSha = json[0]?.sha
  return typeof commitSha === 'string' && commitSha.length > 0 ? commitSha : null
}

async function fetchSpecForCommit(
  commitSha: string,
  fetch: typeof globalThis.fetch
): Promise<OpenApiSpec> {
  const url = `https://raw.githubusercontent.com/stripe/openapi/${commitSha}/latest/openapi.spec3.sdk.json`
  const response = await fetch(url, { headers: githubHeaders() })
  if (!response.ok) {
    throw new Error(
      `Failed to download Stripe OpenAPI spec for commit ${commitSha} (${response.status} ${response.statusText})`
    )
  }

  const spec = (await response.json()) as unknown
  validateOpenApiSpec(spec)
  return spec
}

function validateOpenApiSpec(spec: unknown): asserts spec is OpenApiSpec {
  if (!spec || typeof spec !== 'object') {
    throw new Error('OpenAPI spec is not an object')
  }
  const candidate = spec as Partial<OpenApiSpec>
  if (typeof candidate.openapi !== 'string' || candidate.openapi.trim().length === 0) {
    throw new Error('OpenAPI spec is missing the "openapi" field')
  }
  if (!candidate.components || typeof candidate.components !== 'object') {
    throw new Error('OpenAPI spec is missing "components"')
  }
  if (!candidate.components.schemas || typeof candidate.components.schemas !== 'object') {
    throw new Error('OpenAPI spec is missing "components.schemas"')
  }
}

function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stripe-sync-engine-openapi',
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}
