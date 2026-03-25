import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.e2e.test.*'],
    testTimeout: 180_000,
  },
})
