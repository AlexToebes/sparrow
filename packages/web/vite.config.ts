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
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
