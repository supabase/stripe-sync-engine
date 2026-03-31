import path from 'node:path'
import { builtinModules } from 'node:module'
import * as esbuild from 'esbuild'

function denoImportsPlugin() {
  const builtins = new Set(builtinModules.map((m) => (m.startsWith('node:') ? m.slice(5) : m)))

  const isBare = (spec) =>
    !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)

  const isBuiltin = (spec) => {
    if (spec.startsWith('node:')) return true
    const root = spec.split('/')[0]
    return builtins.has(root)
  }

  return {
    name: 'deno-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path
        if (!isBare(spec)) return

        if (isBuiltin(spec)) {
          return {
            path: spec.startsWith('node:') ? spec : `node:${spec}`,
            external: true,
          }
        }

        // @stripe/* workspace packages are bundled inline from the monorepo.
        // Everything else is externalized as npm: for Deno resolution.
        if (spec.startsWith('@stripe/')) return

        return { path: `npm:${spec}`, external: true }
      })
    },
  }
}

const rawTsBundledPlugin = {
  name: 'raw-ts-bundled',
  setup(build) {
    build.onResolve({ filter: /\.tsx?\?raw$/ }, (args) => {
      const withoutQuery = args.path.replace(/\?raw$/, '')
      return {
        path: path.resolve(args.resolveDir, withoutQuery),
        namespace: 'raw-ts-bundled',
      }
    })

    build.onLoad({ filter: /.*/, namespace: 'raw-ts-bundled' }, async (args) => {
      const result = await esbuild.build({
        entryPoints: [args.path],
        absWorkingDir: process.cwd(),
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        external: ['npm:*', 'chalk', 'inquirer', './edge-function-code'],
        sourcemap: false,
        minify: false,
        logLevel: 'silent',
        plugins: [denoImportsPlugin()],
      })

      const bundled = result.outputFiles?.[0]?.text ?? ''

      return {
        contents: `export default ${JSON.stringify(bundled)};`,
        loader: 'js',
      }
    })
  },
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['npm:*', 'esbuild'],
  plugins: [rawTsBundledPlugin],
})

// Generate declarations
const { execSync } = await import('node:child_process')
execSync('tsc --emitDeclarationOnly', { stdio: 'inherit' })
