import { defineConfig } from 'vite'
export default defineConfig({ root: 'client', base: './', build: { outDir: '../client-dist', emptyOutDir: true }, server: { strictPort: true } })
