import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // docker.test.ts runs execSync to build a Docker image in beforeAll (~90 s),
    // which blocks the worker's event loop. The default pool='threads' uses
    // worker_threads; when those block, the main Vitest process times out on
    // internal RPC calls. pool='forks' uses child_process.fork + IPC, which
    // is less sensitive to the worker event loop being blocked.
    pool: 'forks',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
