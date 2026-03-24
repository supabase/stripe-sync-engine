import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts', 'src/serve-command.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  shims: true,
  noExternal: [/^@stripe\//],
})
