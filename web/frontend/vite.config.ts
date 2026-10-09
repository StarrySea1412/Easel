import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Open preview tabs still lazy-load their original hashed modules after a rebuild.
  // Packaging explicitly requests a clean output; local preview keeps old chunks.
  build: { emptyOutDir: process.env.EASEL_CLEAN_FRONTEND_BUILD === '1' },
  base: './',  // 相对路径，适配 proxy
})
