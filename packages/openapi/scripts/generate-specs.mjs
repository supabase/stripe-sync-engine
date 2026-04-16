#!/usr/bin/env node
/**
 * Fetches Stripe REST API spec versions from github.com/stripe/openapi and
 * writes <version>.json + manifest.json to <outputDir>.
 *
 * Usage:
 *   # All versions (CDN):
 *   node packages/openapi/scripts/generate-specs.mjs <outputDir>
 *
 *   # Specific versions only (e.g. to update the bundled spec in oas/):
 *   node packages/openapi/scripts/generate-specs.mjs <outputDir> --versions 2026-03-25.dahlia
 *   node packages/openapi/scripts/generate-specs.mjs <outputDir> --versions 2026-03-25.dahlia,2026-02-25.clover
 *
 * Clones stripe/openapi (single-branch) then walks the full history, collecting
 * versions (deduplicated by blob SHA). When --versions is given, only those
 * versions are written to <outputDir>.
 * Set STRIPE_OPENAPI_REPO to a pre-cloned path to skip the clone (e.g. CI cache).
 *
 * Also updates src/versions.ts with the discovered version list.
 *
 * These are the official Stripe REST API specs (github.com/stripe/openapi), NOT
 * the Sync Engine's own OpenAPI spec.
 *
 * No npm dependencies.
 */
import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const outputDir = args.find((a) => !a.startsWith('--'))
if (!outputDir) {
  console.error('Usage: node generate-specs.mjs <outputDir> [--versions v1,v2,...]')
  process.exit(1)
}

const versionsArg = args.find((a) => a.startsWith('--versions=') || a === '--versions')
const versionsIdx = args.indexOf('--versions')
const versionFilter = versionsArg?.startsWith('--versions=')
  ? new Set(versionsArg.slice('--versions='.length).split(',').filter(Boolean))
  : versionsIdx !== -1
    ? new Set(args[versionsIdx + 1]?.split(',').filter(Boolean) ?? [])
    : null // null = no filter, collect all

const REPO_URL = 'https://github.com/stripe/openapi'
// stripe/openapi uses 'latest/openapi.spec3.sdk.json' for recent specs and
// 'openapi/spec3.json' for historic ones.
const SPEC_PATHS = ['latest/openapi.spec3.sdk.json', 'openapi/spec3.json']

function git(...gitArgs) {
  // maxBuffer: Stripe specs are ~10 MB each; default 1 MB would silently truncate/throw.
  return execFileSync('git', ['-C', repoDir, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  })
}

// Clone or use pre-cloned repo
const repoDir = process.env.STRIPE_OPENAPI_REPO ?? join(tmpdir(), 'stripe-openapi')
if (!existsSync(join(repoDir, '.git'))) {
  console.error(`Cloning ${REPO_URL}...`)
  execFileSync('git', ['clone', '--single-branch', REPO_URL, repoDir], { stdio: 'inherit' })
} else {
  console.error(`Using pre-cloned repo at ${repoDir}`)
}

console.error(
  versionFilter
    ? `Collecting versions: ${[...versionFilter].join(', ')}`
    : 'Collecting all spec versions...'
)
const commits = git('log', '--format=%H', '--', ...SPEC_PATHS)
  .trim()
  .split('\n')
  .filter(Boolean)

mkdirSync(outputDir, { recursive: true })

const seen = new Map() // version -> filename
const seenBlobs = new Set()

for (const commit of commits) {
  // Stop early if we've found all requested versions
  if (versionFilter && versionFilter.size === seen.size) break

  let blobSha
  for (const specPath of SPEC_PATHS) {
    let ls
    try {
      ls = git('ls-tree', commit, specPath).trim()
    } catch {
      continue
    }
    if (!ls) continue
    blobSha = ls.split(/\s+/)[2]
    break
  }
  if (!blobSha || seenBlobs.has(blobSha)) continue
  seenBlobs.add(blobSha)

  let raw
  try {
    raw = git('cat-file', 'blob', blobSha)
  } catch {
    continue
  }

  let version
  try {
    version = JSON.parse(raw).info?.version
  } catch {
    continue
  }
  if (!version || seen.has(version)) continue
  if (versionFilter && !versionFilter.has(version)) continue

  writeFileSync(join(outputDir, `${version}.json`), raw)
  seen.set(version, `${version}.json`)
  console.error(`  ${version}`)
}

if (versionFilter) {
  const missing = [...versionFilter].filter((v) => !seen.has(v))
  if (missing.length > 0) {
    console.error(`Warning: versions not found in stripe/openapi history: ${missing.join(', ')}`)
  }
}

writeFileSync(
  join(outputDir, 'manifest.json'),
  JSON.stringify(Object.fromEntries(seen), null, 2) + '\n'
)

// Update src/versions.ts — for a version-filtered run, only update BUNDLED_API_VERSION
// (the oas/ spec files); for a full run, update the complete SUPPORTED_API_VERSIONS list.
const oasDir = join(__dirname, '..', 'oas')
const bundledFiles = readdirSync(oasDir).filter(
  (f) => f.endsWith('.json') && f !== 'manifest.json' && f !== 'index.html'
)
const bundled = bundledFiles[0]?.replace(/\.json$/, '') ?? [...seen.keys()].sort().reverse()[0]

const supportedVersions = versionFilter
  ? // Filtered run: read existing versions from src/versions.ts to preserve the full list
    await import('../src/versions.ts', { with: { type: 'module' } })
      .then((m) => [...m.SUPPORTED_API_VERSIONS])
      .catch(() => [...seen.keys()])
  : [...seen.keys()].sort().reverse()

const lines = supportedVersions.map((v) => `  '${v}',`).join('\n')
const versionsFile = join(__dirname, '..', 'src', 'versions.ts')
writeFileSync(
  versionsFile,
  `// Generated by scripts/generate-specs.mjs — do not edit manually.
// BUNDLED_API_VERSION: the single spec file in packages/openapi/oas/.
// SUPPORTED_API_VERSIONS: all versions discovered from github.com/stripe/openapi.
// Re-run scripts/generate-specs.mjs to pick up newly published API versions.

/** The single Stripe API spec bundled in this package (served without network). */
export const BUNDLED_API_VERSION = '${bundled}' as const

/** All Stripe API versions published by Stripe, newest first. */
export const SUPPORTED_API_VERSIONS = [
${lines}
] as const satisfies readonly string[]
`
)
console.error(`Updated src/versions.ts (${supportedVersions.length} versions, bundled: ${bundled})`)

// Generate an index page (CDN use) — only when writing all versions
if (!versionFilter) {
  const versions = [...seen.keys()].sort().reverse()
  const rows = versions.map((v) => `    <li><a href="${seen.get(v)}">${v}</a></li>`).join('\n')
  writeFileSync(
    join(outputDir, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Stripe REST API Specs — stripe-sync.dev CDN</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 700px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    p { color: #555; }
    ul { list-style: none; padding: 0; }
    li { margin: .25rem 0; }
    a { color: #5469d4; text-decoration: none; font-family: monospace; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Stripe REST API OpenAPI Specs</h1>
  <p>
    These are the official <strong>Stripe REST API</strong> specs from
    <a href="https://github.com/stripe/openapi">github.com/stripe/openapi</a>,
    mirrored here to avoid GitHub API rate limits.
    This is <em>not</em> the Sync Engine's own OpenAPI spec
    (see <a href="/openapi/engine.json">engine.json</a> for that).
  </p>
  <p>Machine-readable index: <a href="manifest.json">manifest.json</a> — ${versions.length} versions available.</p>
  <ul>
${rows}
  </ul>
</body>
</html>
`
  )
}

console.error(`\nDone: ${seen.size} spec version(s)`)
