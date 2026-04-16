#!/usr/bin/env node
/**
 * CDN spec generation — thin wrapper around packages/openapi/scripts/generate-specs.mjs.
 *
 * Usage:
 *   node docs/scripts/generate-stripe-specs.mjs <outputDir>
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const script = join(__dirname, '..', '..', 'packages', 'openapi', 'scripts', 'generate-specs.mjs')

execFileSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' })
