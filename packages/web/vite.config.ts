import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The API is served by the Fastify server (default port 3000). In dev, Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  // Use @sparrow/shared TS source (the "source" export condition) so no shared build is needed first.
  resolve: { conditions: [...defaultClientConditions, 'source'] },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:3000' },
  },
  // Source maps are off for production builds (they were 4 MB, over five times the bundle, and
  // shipped in the image). SOURCEMAP=1 builds hidden maps for debugging a build locally.
  build: { outDir: 'dist', sourcemap: process.env.SOURCEMAP === '1' ? 'hidden' : false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
    // Full-suite load (parallel jsdom workers) made multi-step dialog flows exceed the 5 s default.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
