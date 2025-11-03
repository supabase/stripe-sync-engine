/// <reference types="vitest" />
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    resolve: {
      alias: [{ find: /(.*)\.js$/, replacement: '$1.ts' }],
    },
    environment: 'node',
    deps: {
      inline: [/.*/], // inline deps for Vite to transform
    },
  },
})
