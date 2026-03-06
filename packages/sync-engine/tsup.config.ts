import { defineConfig } from 'tsup'
import path from 'node:path'
import * as esbuild from 'esbuild'

import { builtinModules } from 'node:module'

export function nodePrefixBuiltinsPlugin(): esbuild.Plugin {
  const builtins = new Set(builtinModules.map((m) => (m.startsWith('node:') ? m.slice(5) : m)))

  const isBare = (spec: string) =>
    !spec.startsWith('.') && !spec.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)

  const isBuiltin = (spec: string) => {
    if (spec.startsWith('node:')) return true
    const root = spec.split('/')[0]
    return builtins.has(root)
  }

  return {
    name: 'deno-imports',
    setup(build) {
      // 1) Intercept builtins and move them into a virtual namespace
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path
        if (!isBare(spec)) return

        let newImport
        if (isBuiltin(spec)) {
          // prefix with node:
          newImport = spec.startsWith('node:') ? spec : `node:${spec}`
        } else {
          // prefix with npm:
          newImport = spec.startsWith('npm:') ? spec : `npm:${spec}`
        }

        return {
          path: newImport,
          namespace: 'deno-import', // <- key fix
        }
      })

      // 2) Emit a tiny ESM module that re-exports the builtin
      build.onLoad({ filter: /.*/, namespace: 'deno-import' }, (args) => {
        const spec = args.path // already "node:xxx"
        return {
          loader: 'js',
          contents: `
            export * from ${JSON.stringify(spec)};
            export { default } from ${JSON.stringify(spec)};
          `,
        }
      })
    },
  }
}

export const rawTsBundledPlugin: esbuild.Plugin = {
  name: 'raw-ts-bundled',
  setup(build) {
    // Resolve `./foo.ts?raw` -> actual `foo.ts` path, in a special namespace
    build.onResolve({ filter: /\.tsx?\?raw$/ }, (args) => {
      const withoutQuery = args.path.replace(/\?raw$/, '')
      return {
        path: path.resolve(args.resolveDir, withoutQuery),
        namespace: 'raw-ts-bundled',
      }
    })

    // Load: bundle the TS module, then export the bundled JS as a string
    build.onLoad({ filter: /.*/, namespace: 'raw-ts-bundled' }, async (args) => {
      // Bundle THIS module (and its dependencies) into a single JS output
      const result = await esbuild.build({
        entryPoints: [args.path],
        absWorkingDir: process.cwd(),
        bundle: true,
        write: false,

        format: 'esm',

        // Match your runtime (tsup usually targets node for libs)
        platform: 'node',
        target: 'node22',

        // You probably want imports preserved for externals (like pg, etc.)
        // NOTE: Keep this aligned with your tsup externals.
        // Also external edge-function-code to avoid circular dependencies
        external: ['npm:*', 'chalk', 'inquirer', './edge-function-code'],

        // Avoid sourcemaps inside the embedded string unless you want them
        sourcemap: false,
        minify: false,

        logLevel: 'silent',
        plugins: [nodePrefixBuiltinsPlugin()],
      })

      const bundled = result.outputFiles?.[0]?.text ?? ''

      return {
        contents: `export default ${JSON.stringify(bundled)};`,
        loader: 'js',
      }
    })
  },
}

export default defineConfig({
  esbuildPlugins: [rawTsBundledPlugin],

  esbuildOptions(options) {
    options.external = options.external || []
    options.external.push('npm:*', 'chalk', 'inquirer', 'esbuild')
  },
})
