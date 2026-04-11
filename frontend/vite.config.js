import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// vite-plugin-pwa is only needed in production builds (generates precache manifest).
// In dev mode (Vite HMR) we skip it entirely to avoid unnecessary complexity.
const isProduction = process.env.NODE_ENV === 'production';

const plugins = [react()];

if (isProduction) {
    // Dynamically import to avoid crashing dev server if the package isn't installed
    const { VitePWA } = await import('vite-plugin-pwa');
    plugins.push(
        VitePWA({
            strategies: 'injectManifest',
            srcDir: '.',
            filename: 'sw.js',
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
                globDirectory: 'dist',
                globPatterns: ['**/*.{js,css,html,png,ico,json,woff2}'],
                injectionPoint: 'self.__WB_MANIFEST',
            },
        })
    );
}

export default defineConfig({
    plugins,
    server: {
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
        allowedHosts: true,
        cors: true,
        hmr: {
            clientPort: 80
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
