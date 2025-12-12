/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    deps: {
      inline: [/.*/],
    },
  },
})
