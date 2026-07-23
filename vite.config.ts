import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project sites are served from /<repo>/. Override at build time with
// VITE_BASE (the deploy workflow sets it to "/<repo-name>/"). Dev uses "/".
export default defineConfig(({ command }) => ({
  base: command === 'build' ? process.env.VITE_BASE || '/fafst/' : '/',
  plugins: [react()],
  build: { outDir: 'dist', assetsInlineLimit: 0 },
}));
