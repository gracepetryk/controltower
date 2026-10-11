import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const { API_URL = 'http://127.0.0.1:3000' } = loadEnv(mode, process.cwd(), '')
  // The API sends no CORS headers, so the dev and preview servers forward /api/* to it.
  const proxy = {
    '/api': {
      target: API_URL,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
  }
  return {
    plugins: [react()],
    server: { proxy },
    preview: { proxy },
  }
})
