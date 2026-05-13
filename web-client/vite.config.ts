import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const statusUiApiTarget = process.env.TYCHONIC_WEB_API_TARGET ?? 'http://127.0.0.1:19733'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: statusUiApiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/web-client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
