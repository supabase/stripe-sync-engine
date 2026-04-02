import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api/engine': {
        target: 'http://localhost:4010',
        rewrite: (p) => p.replace(/^\/api\/engine/, ''),
      },
      '/api/service': {
        target: 'http://localhost:4020',
        rewrite: (p) => p.replace(/^\/api\/service/, ''),
      },
    },
  },
})
