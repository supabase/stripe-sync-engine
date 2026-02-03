#!/usr/bin/env tsx
import * as esbuild from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  nodePrefixBuiltinsPlugin,
  rawTsBundledPlugin,
  embeddedMigrationsPlugin,
} from '../tsup.config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src/supabase/edge-functions')
const outDir = path.join(rootDir, 'dist/supabase/functions')

if (!fs.existsSync(srcDir)) {
  console.error(`Source directory not found: ${srcDir}`)
  process.exit(1)
}

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))

console.log(`Found ${files.length} functions in ${srcDir}`)

async function build() {
  for (const file of files) {
    const name = path.basename(file, '.ts')
    const entryPoint = path.join(srcDir, file)
    const functionOutDir = path.join(outDir, name)

    // Ensure function output directory exists
    if (!fs.existsSync(functionOutDir)) {
      fs.mkdirSync(functionOutDir, { recursive: true })
    }

    const outfile = path.join(functionOutDir, 'index.js')
    console.log(`Building ${name} -> ${outfile}`)

    try {
      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        outfile: outfile,
        format: 'esm',
        target: 'esnext',
        platform: 'neutral', // Using neutral for Deno/Edge compatibility
        // Externalize common Deno/Edge patterns and what's in tsup config
        external: ['npm:*', 'node:*', 'jsr:*', 'chalk', 'inquirer'],
        plugins: [nodePrefixBuiltinsPlugin(), rawTsBundledPlugin, embeddedMigrationsPlugin],
        logLevel: 'info',
      })
    } catch (error) {
      console.error(`Failed to build ${name}:`, error)
      process.exit(1)
    }
  }
}

build()
