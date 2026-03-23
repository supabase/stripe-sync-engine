import Markdoc from '@markdoc/markdoc'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.dirname(new URL(import.meta.url).pathname)
const PAGES_DIR = path.join(ROOT, 'pages')
const PUBLIC_DIR = path.join(ROOT, 'public')
const OUT_DIR = path.join(ROOT, 'out')
const LAYOUT = fs.readFileSync(path.join(ROOT, 'layout.html'), 'utf8')

// Clean + create output dir
fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

// Copy public assets
if (fs.existsSync(PUBLIC_DIR)) {
  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    fs.copyFileSync(path.join(PUBLIC_DIR, file), path.join(OUT_DIR, file))
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
