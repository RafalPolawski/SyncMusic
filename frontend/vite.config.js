import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        host: '0.0.0.0',   // Bind to all interfaces — required for Docker networking
        port: 5173,
        strictPort: true,
        allowedHosts: true, // Accept requests from any host (Tailscale, LAN, localhost)
        cors: true,
        hmr: {
            clientPort: 5173  // Ensures HMR websocket uses the correct port through the proxy chain
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
