/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node',
    deps: {
      inline: [/.*/], // inline deps for Vite to transform
    },
  },
})
