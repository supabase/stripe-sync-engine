import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Server integration tests require a running Postgres and built dist/migrations.
      // Run them separately with: vitest --config vitest.config.server.ts
      'src/server/__tests__/**',
    ],
    deps: {
      inline: [/.*/],
    },
  },
})
