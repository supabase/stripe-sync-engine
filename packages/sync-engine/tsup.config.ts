import { defineConfig } from 'tsup'
import fs from 'node:fs/promises'
import path from 'node:path'

const rawTsPlugin = {
  name: 'raw-ts',
  setup(build) {
    // Resolve `./foo.ts?raw` → actual `foo.ts` path, but in a "raw" namespace
    build.onResolve({ filter: /\.ts\?raw$/ }, (args) => {
      const withoutQuery = args.path.replace(/\?raw$/, '')
      console.log('Resolving raw TS file:', withoutQuery)
      return {
        path: path.resolve(args.resolveDir, withoutQuery),
        namespace: 'raw-ts',
      }
    })

    // Load that path and turn it into 'export default "<escaped source>"'
    build.onLoad({ filter: /.*/, namespace: 'raw-ts' }, async (args) => {
      const source = await fs.readFile(args.path, 'utf8')
      console.log('Loading raw TS file:', args.path)
      return {
        contents: `export default ${JSON.stringify(source)};`,
        loader: 'js', // esbuild will treat this as normal JS
      }
    })
  },
}

export default defineConfig({
  esbuildPlugins: [rawTsPlugin],
  esbuildOptions(options) {
    // Prevent esbuild from trying to bundle 'pg' (native module)
    options.external = options.external || []
    options.external.push('npm:*')
  },
})
