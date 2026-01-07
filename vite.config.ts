import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        approval: resolve(__dirname, 'approval.html'),
        service_worker: resolve(__dirname, 'src/background/service_worker.ts'),
        content_script: resolve(__dirname, 'src/content_script.ts'),
        injected_provider: resolve(__dirname, 'src/injected/provider.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  test: {
    environment: 'jsdom'
  }
})
