/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node', // or 'jsdom' if you need browser APIs
    deps: {
      inline: [/.*/], // optionally to inline all deps
    },
  },
})
