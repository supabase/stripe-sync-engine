import Markdoc from '@markdoc/markdoc'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const PAGES_DIR = ROOT
const PUBLIC_DIR = path.join(ROOT, 'public')
const OPENAPI_DIR = path.join(ROOT, 'openapi')
const OUT_DIR = path.join(ROOT, 'out')
const LAYOUT = fs.readFileSync(path.join(ROOT, 'layout.html'), 'utf8')

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

// Clean + create output dir
fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

// Copy public assets
if (fs.existsSync(PUBLIC_DIR)) copyDir(PUBLIC_DIR, OUT_DIR)

// Copy Sync Engine OpenAPI specs (engine/service/webhook) → /openapi/
if (fs.existsSync(OPENAPI_DIR)) copyDir(OPENAPI_DIR, path.join(OUT_DIR, 'openapi'))

// Generate official Stripe API specs (from stripe/openapi) → /stripe-api-specs/
// These are the upstream Stripe REST API specs, NOT the Sync Engine API.
// Served as a CDN mirror so consumers avoid GitHub rate limits.
// Skipped when SKIP_STRIPE_SPECS=1 (e.g. quick local builds).
if (process.env.SKIP_STRIPE_SPECS !== '1') {
  console.log('Generating Stripe API specs...')
  const stripeSpecDir = path.join(OUT_DIR, 'stripe-api-specs')
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'generate-stripe-specs.mjs'), stripeSpecDir],
    { stdio: 'inherit' }
  )
  if (result.status !== 0) {
    console.error('Warning: Stripe API spec generation failed — CDN specs will be unavailable')
  }
}

// Collect all .md files recursively under PAGES_DIR
function collectPages(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const pages = []
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      pages.push(...collectPages(path.join(dir, entry.name), rel))
    } else if (entry.name.endsWith('.md')) {
      pages.push(rel)
    }
  }
  return pages
}

const pages = collectPages(PAGES_DIR)

for (const page of pages) {
  const source = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8')
  const ast = Markdoc.parse(source)
  const frontmatter = ast.attributes.frontmatter
    ? Object.fromEntries(
        ast.attributes.frontmatter.split('\n').flatMap((line) => {
          const match = /^(\w+):\s*(.+)$/.exec(line.trim())
          return match ? [[match[1], match[2]]] : []
        })
      )
    : {}

  const content = Markdoc.transform(ast)
  const html = Markdoc.renderers.html(content)

  const title = frontmatter.title ?? 'Stripe Sync Engine'
  const output = LAYOUT.replace('{{title}}', title).replace('{{content}}', html)

  const outName = page.replace(/\.md$/, '.html')
  fs.mkdirSync(path.join(OUT_DIR, path.dirname(outName)), { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, outName), output)
  console.log(`  ${page} → ${outName}`)
}

console.log(`\nBuilt ${pages.length} page(s) → docs/out/`)
