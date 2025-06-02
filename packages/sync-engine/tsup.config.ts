import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: 'esm',
    outDir: 'dist/esm',
    dts: { resolve: true },
    sourcemap: true,
    clean: true,
    outExtension: () => ({ js: '.js' }),
  },
  {
    entry: ['src/index.ts'],
    format: 'cjs',
    outDir: 'dist/cjs',
    dts: { resolve: true },
    sourcemap: true,
    clean: false,
    outExtension: () => ({ js: '.js' }),
  },
])
