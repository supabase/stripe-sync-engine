import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { OpenApiSpec, ResolveSpecConfig, ResolvedOpenApiSpec } from './types'

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'stripe-sync-openapi-cache')

export async function resolveOpenApiSpec(config: ResolveSpecConfig): Promise<ResolvedOpenApiSpec> {
  const apiVersion = config.apiVersion
  if (!apiVersion || !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)) {
    throw new Error(`Invalid Stripe API version "${apiVersion}". Expected YYYY-MM-DD.`)
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

  const commitSha = await resolveCommitShaForApiVersion(apiVersion)
  if (!commitSha) {
    throw new Error(
      `Could not resolve Stripe OpenAPI commit for API version ${apiVersion} and no local spec path was provided.`
    )
  }

  const spec = await fetchSpecForCommit(commitSha)
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

function getCachePath(cacheDir: string, apiVersion: string): string {
  const safeVersion = apiVersion.replace(/[^0-9a-zA-Z_-]/g, '_')
  return path.join(cacheDir, `${safeVersion}.spec3.json`)
}

async function resolveCommitShaForApiVersion(apiVersion: string): Promise<string | null> {
  const until = `${apiVersion}T23:59:59Z`
  const url = new URL('https://api.github.com/repos/stripe/openapi/commits')
  url.searchParams.set('path', 'openapi/spec3.json')
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

async function fetchSpecForCommit(commitSha: string): Promise<OpenApiSpec> {
  const url = `https://raw.githubusercontent.com/stripe/openapi/${commitSha}/openapi/spec3.json`
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
