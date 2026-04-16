import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, relative } from 'path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const packagesDir = resolve(ROOT, 'packages')
const appsDir = resolve(ROOT, 'apps')

function readPkgJson(dir: string): { name: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'))
}

/** Recursively collect all .ts files under a directory (skipping tests and node_modules). */
function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

/** Extract import specifiers from a TypeScript file. */
function extractImports(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8')
  const imports: string[] = []
  // Match: import ... from '...' / import '...' / require('...')
  for (const match of content.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)) {
    imports.push(match[1])
  }
  return imports
}

const sourceDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('source-'))
  .map((d) => d.name)

const destDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('destination-'))
  .map((d) => d.name)

// MARK: - Source/Destination isolation

describe('source/destination isolation', () => {
  for (const dir of sourceDirs) {
    it(`packages/${dir} does not import from any destination`, () => {
      const srcDir = resolve(packagesDir, dir, 'src')
      const files = collectSourceFiles(srcDir)
      const violations: string[] = []
      for (const file of files) {
        for (const imp of extractImports(file)) {
          if (imp.includes('destination-') || imp.includes('sync-destination')) {
            const rel = relative(ROOT, file)
            violations.push(`${rel} imports ${imp}`)
          }
        }
      }
      expect(
        violations,
        `LAYER VIOLATION: Sources must not import destinations.\n` +
          `See docs/architecture/packages.md\n` +
          violations.join('\n')
      ).toHaveLength(0)
    })
  }

  for (const dir of destDirs) {
    it(`packages/${dir} does not import from any source`, () => {
      const srcDir = resolve(packagesDir, dir, 'src')
      const files = collectSourceFiles(srcDir)
      const violations: string[] = []
      for (const file of files) {
        for (const imp of extractImports(file)) {
          if (imp.includes('source-') || imp.includes('sync-source')) {
            const rel = relative(ROOT, file)
            violations.push(`${rel} imports ${imp}`)
          }
        }
      }
      expect(
        violations,
        `LAYER VIOLATION: Destinations must not import sources.\n` +
          `See docs/architecture/packages.md\n` +
          violations.join('\n')
      ).toHaveLength(0)
    })
  }
})

// MARK: - Protocol independence

describe('protocol independence', () => {
  it('packages/protocol does not import from any other @stripe/sync-* package', () => {
    const srcDir = resolve(packagesDir, 'protocol', 'src')
    const files = collectSourceFiles(srcDir)
    const violations: string[] = []
    for (const file of files) {
      for (const imp of extractImports(file)) {
        if (imp.startsWith('@stripe/sync-') && !imp.startsWith('@stripe/sync-protocol')) {
          const rel = relative(ROOT, file)
          violations.push(`${rel} imports ${imp}`)
        }
      }
    }
    expect(
      violations,
      `LAYER VIOLATION: protocol must have zero workspace dependencies.\n` +
        `See docs/architecture/packages.md\n` +
        violations.join('\n')
    ).toHaveLength(0)
  })
})

// MARK: - Connector package.json deps

describe('connector package.json dependencies', () => {
  const FORBIDDEN_CONNECTOR_DEPS = new Set([
    '@stripe/sync-engine',
    '@stripe/sync-service',
    '@stripe/sync-state-postgres',
  ])

  for (const dir of [...sourceDirs, ...destDirs]) {
    it(`packages/${dir} does not depend on engine, service, or state-postgres`, () => {
      const pkg = readPkgJson(resolve(packagesDir, dir))
      const deps = Object.keys(pkg.dependencies ?? {})
      const violations = deps.filter((d) => FORBIDDEN_CONNECTOR_DEPS.has(d))
      expect(
        violations,
        `LAYER VIOLATION: Connector ${pkg.name} depends on ${violations.join(', ')}.\n` +
          `Connectors must not depend on engine, service, or state packages.\n` +
          `See docs/architecture/packages.md`
      ).toHaveLength(0)
    })
  }
})

// MARK: - Service isolation

describe('service isolation', () => {
  it('apps/service does not directly depend on pg', () => {
    const pkg = readPkgJson(resolve(appsDir, 'service'))
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(
      deps.includes('pg'),
      `LAYER VIOLATION: apps/service lists pg as a direct dependency.\n` +
        `Postgres stores should be injected, not imported directly.\n` +
        `See docs/architecture/packages.md`
    ).toBe(false)
  })
})

// MARK: - Standalone packages (no workspace dependencies)

describe('standalone packages', () => {
  const STANDALONE = ['util-postgres', 'openapi', 'ts-cli']

  for (const dir of STANDALONE) {
    it(`packages/${dir} does not import any @stripe/sync-* workspace package`, () => {
      const srcDir = resolve(packagesDir, dir, 'src')
      const files = collectSourceFiles(srcDir)
      const violations: string[] = []
      for (const file of files) {
        for (const imp of extractImports(file)) {
          if (imp.startsWith('@stripe/sync-')) {
            const rel = relative(ROOT, file)
            violations.push(`${rel} imports ${imp}`)
          }
        }
      }
      expect(
        violations,
        `LAYER VIOLATION: packages/${dir} must have zero workspace dependencies.\n` +
          `See docs/architecture/packages.md\n` +
          violations.join('\n')
      ).toHaveLength(0)
    })
  }
})

// MARK: - App layer ordering

describe('app layer ordering', () => {
  it('apps/engine does not import from apps/service', () => {
    const srcDir = resolve(appsDir, 'engine', 'src')
    const files = collectSourceFiles(srcDir)
    const violations: string[] = []
    for (const file of files) {
      for (const imp of extractImports(file)) {
        if (imp.includes('@stripe/sync-service')) {
          const rel = relative(ROOT, file)
          violations.push(`${rel} imports ${imp}`)
        }
      }
    }
    expect(
      violations,
      `LAYER VIOLATION: apps/engine must not import from apps/service.\n` +
        `Service depends on engine, not the reverse.\n` +
        `See docs/architecture/packages.md\n` +
        violations.join('\n')
    ).toHaveLength(0)
  })
})
