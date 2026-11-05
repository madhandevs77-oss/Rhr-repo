import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = process.env.VITE_API_TARGET || 'http://127.0.0.1:3001'
export default defineConfig({
  plugins: [react()],
  base: './',
  server: { proxy: { '/api': api, '/uploads': api } },
  preview: { proxy: { '/api': api, '/uploads': api } },
})
