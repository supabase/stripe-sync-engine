import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/*.integration.test.*', '**/*.e2e.test.*', '**/node_modules/**'],
  },
})
