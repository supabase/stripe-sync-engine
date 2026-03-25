import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'src/__tests__/docker.test.ts',
      'src/__tests__/stripe-to-postgres.test.ts',
    ],
    // docker.test.ts builds a Docker image in beforeAll (~90 s).
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
