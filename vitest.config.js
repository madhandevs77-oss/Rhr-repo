import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom', include: ['src/__tests__/**/*.test.{js,jsx}'], setupFiles: ['src/__tests__/setup.js'], css: false },
})
