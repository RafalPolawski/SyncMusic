import { defineConfig } from 'vite'

export default defineConfig({
    server: {
        host: '0.0.0.0', // Nasłuchuj na wszystkich interfejsach sieciowych (zależne dla Dockera)
        port: 5173,
        strictPort: true,
        allowedHosts: true, // Akceptuj zapytania z innych hostów/IP np. Tailscale
        cors: true,
        hmr: {
            clientPort: 5173 // Upewnia HMR że gadamy przez dobry port przez VPN
        },
        proxy: {
            '/api': {
                target: 'http://sync-app:12137',
                changeOrigin: true
            },
            '/ws': {
                target: 'ws://sync-app:12137',
                ws: true
            },
            '/music': {
                target: 'http://sync-app:12137',
                changeOrigin: true
            }
        }
    }
})
