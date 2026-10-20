import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import scalableTypography from './scripts/scalable-typography.js'

// Product version has one source; the UI records the version it was built from.
const source = readFileSync(new URL('../../pyproject.toml', import.meta.url), 'utf8')
const version = source.split('[project]')[1]?.split(/\n\[/)[0]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
if (!version) throw new Error('Missing Easel product version')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [scalableTypography()] } },
  define: { __EASEL_UI_VERSION__: JSON.stringify(version), __EASEL_UI_BUILT_AT__: JSON.stringify(new Date().toISOString()) },
  // Open preview tabs still lazy-load their original hashed modules after a rebuild.
  // Packaging explicitly requests a clean output; local preview keeps old chunks.
  build: { emptyOutDir: process.env.EASEL_CLEAN_FRONTEND_BUILD === '1' },
  base: './',  // 相对路径，适配 proxy
})
