import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/*.integration.test.*', '**/node_modules/**'],
  },
})
