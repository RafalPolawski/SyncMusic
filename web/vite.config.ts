/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.SYNCMUSIC_DEV_BACKEND ?? 'http://localhost:8080';

/**
 * Builds src/sw.ts as a stand-alone /sw.js and injects the list of emitted
 * files (the app shell) plus a content hash used as the cache version.
 */
function serviceWorker(): Plugin {
  return {
    name: 'syncmusic-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const sw = Object.values(bundle).find((c) => c.type === 'chunk' && c.name === 'sw');
      if (!sw || sw.type !== 'chunk') return;
      const publicFiles = readdirSync('public').filter((f) => !f.startsWith('.'));
      const files = [...Object.keys(bundle), ...publicFiles]
        .filter((f) => f !== sw.fileName && !f.endsWith('.map'))
        .map((f) => '/' + f);
      const precache = ['/', ...files.filter((f) => f !== '/index.html')].sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      sw.code = sw.code
        .replace('self.__PRECACHE__', JSON.stringify(precache))
        .replace('self.__SW_VERSION__', JSON.stringify(version));
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      input: { main: 'index.html', sw: 'src/sw.ts' },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: backend,
        changeOrigin: true,
        ws: true,
        configure: (proxy) => {
          // The backend only accepts same-origin WebSockets.
          proxy.on('proxyReqWs', (req) => req.setHeader('origin', backend));
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/sw.ts'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
