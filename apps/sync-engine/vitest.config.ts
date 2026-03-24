import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // docker.test.ts builds a Docker image in beforeAll which blocks the
    // worker for ~90 s. Raise the RPC timeout (default: 5 s) so the main
    // process doesn't declare the worker dead mid-build.
    rpcTimeout: 300_000,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
