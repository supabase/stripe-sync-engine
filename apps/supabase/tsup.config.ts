import { defineConfig } from 'tsup'
import path from 'node:path'
import * as esbuild from 'esbuild'

import { builtinModules } from 'node:module'

function nodePrefixBuiltinsPlugin(): esbuild.Plugin {
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
      build.onResolve({ filter: /.*/ }, (args) => {
        const spec = args.path
        if (!isBare(spec)) return

        let newImport
        if (isBuiltin(spec)) {
          newImport = spec.startsWith('node:') ? spec : `node:${spec}`
        } else {
          newImport = spec.startsWith('npm:') ? spec : `npm:${spec}`
        }

        return {
          path: newImport,
          namespace: 'deno-import',
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'deno-import' }, (args) => {
        const spec = args.path
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

const rawTsBundledPlugin: esbuild.Plugin = {
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
    options.external.push('npm:*', 'esbuild')
  },
})
