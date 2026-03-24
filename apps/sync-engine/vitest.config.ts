import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // docker.test.ts builds a Docker image in beforeAll (~90 s).
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
