import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/realtime': 'http://localhost:4500',
      '/tools': 'http://localhost:4500',
      '/user': 'http://localhost:4500',
      '/sessions': 'http://localhost:4500',
      '/auth': 'http://localhost:4500',
      '/health': 'http://localhost:4500',
    },
  },
})

