import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// AppHub is served as static assets from node1 behind nginx; the API is same-origin
// under /api (proxied to the Node control plane). In dev we proxy to the mock or a
// local backend via VITE_API_PROXY.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: process.env.VITE_API_PROXY
      ? { '/api': { target: process.env.VITE_API_PROXY, changeOrigin: true } }
      : undefined,
  },
  build: {
    // Separate budgets for JS / CSS / fonts per ADR-006.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
}))
