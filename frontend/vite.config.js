import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    plugins: [
        VitePWA({
            // Use our hand-crafted sw.js as the base, but inject the precache manifest into it
            strategies: 'injectManifest',
            srcDir: '.',
            filename: 'sw.js',
            // In dev (Vite HMR), register the SW but don't activate it automatically
            // so hot reload still works normally
            devOptions: {
                enabled: true,
                type: 'module',
            },
            manifest: {
                name: 'SyncMusic',
                short_name: 'SyncMusic',
                description: 'Listen to music perfectly synchronized across multiple devices.',
                start_url: '/',
                display: 'standalone',
                background_color: '#0f0c29',
                theme_color: '#1DB954',
                icons: [
                    { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
                    { src: '/icon-512.png', type: 'image/png', sizes: '512x512', purpose: 'any maskable' },
                ],
            },
            injectManifest: {
                // Files to precache — inject Vite-generated asset list into sw.js
                globDirectory: 'dist',
                globPatterns: ['**/*.{js,css,html,png,ico,json,woff2}'],
                // Inject into the placeholder in sw.js
                injectionPoint: 'self.__WB_MANIFEST',
            },
        }),
    ],
    server: {
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
        allowedHosts: true,
        cors: true,
        hmr: {
            clientPort: 5173
        },
        proxy: {
            '/api': {
                target: 'http://sync-app:12137',
                changeOrigin: true
            },
            '/music': {
                target: 'http://sync-app:12137',
                changeOrigin: true
            }
        }
    }
})
