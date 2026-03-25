#!/usr/bin/env node

/**
 * Codemod: Add .js extensions to all relative import/export specifiers.
 *
 * - Rewrites `from './foo'` → `from './foo.js'`
 * - Rewrites `from '../foo'` → `from '../foo.js'`
 * - Directory imports: `from './subdir'` → `from './subdir/index.js'` (when subdir/index.ts exists)
 * - Skips bare specifiers, already-extensioned imports, and non-relative paths
 * - Handles both `import` and `export` statements
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { dirname, resolve, join } from 'path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

// Find all .ts files in packages/ and apps/, excluding node_modules and dist
const files = execSync(
  `find ${ROOT}/packages ${ROOT}/apps -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*'`,
  { encoding: 'utf8' }
)
  .trim()
  .split('\n')
  .filter(Boolean)

// Regex to match import/export ... from '...' or import '...'
// Handles: import, export, import type, export type, import(...) is handled separately
const importExportRe =
  /(?:(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|[^;'"]*)\s+from\s+|import\s+)['"](\.[^'"]+)['"]/g

let totalChanges = 0
let filesChanged = 0

for (const filePath of files) {
  const original = readFileSync(filePath, 'utf8')
  const fileDir = dirname(filePath)

  let changed = false
  const result = original.replace(importExportRe, (match, specifier) => {
    // Skip if already has an extension
    if (/\.\w+$/.test(specifier) && !specifier.endsWith('/')) {
      return match
    }

    // Skip non-relative imports (shouldn't match our regex, but be safe)
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      return match
    }

    // Resolve the specifier relative to the file
    const resolved = resolve(fileDir, specifier)

    // Check if it's a directory import (directory exists with index.ts inside)
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      if (existsSync(join(resolved, 'index.ts'))) {
        const newSpecifier = specifier + '/index.js'
        changed = true
        totalChanges++
        return match.replace(specifier, newSpecifier)
      }
    }

    // Check if the .ts file exists
    if (existsSync(resolved + '.ts') || existsSync(resolved + '.tsx')) {
      const newSpecifier = specifier + '.js'
      changed = true
      totalChanges++
      return match.replace(specifier, newSpecifier)
    }

    // If neither file nor directory resolves, leave it alone and warn
    console.warn(`  WARN: Cannot resolve '${specifier}' in ${filePath}`)
    return match
  })

  if (changed) {
    writeFileSync(filePath, result)
    filesChanged++
    console.log(`  Modified: ${filePath.replace(ROOT + '/', '')}`)
  }
}

console.log(`\nDone: ${totalChanges} imports updated across ${filesChanged} files`)
