import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The Express API (../server) runs on :4000; proxying keeps the browser same-origin.
  server: {
    proxy: { '/api': 'http://localhost:4000' },
  },
})
