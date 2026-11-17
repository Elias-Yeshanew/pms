import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// In development the API runs on :3000; the proxy avoids CORS. In production serve both behind one domain, or set VITE_API_URL.
// The service worker keeps the app itself available when a tablet restarts without a connection. API calls are never cached.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Pharmacy Management', short_name: 'Pharmacy', start_url: '/pos', display: 'standalone', background_color: '#ffffff', theme_color: '#177069',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: { navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//], globPatterns: ['**/*.{js,css,html,svg}'], runtimeCaching: [] },
      devOptions: { enabled: false },
    }),
  ],
  server: { port: 5173, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' } },
  preview: { port: 4173, proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' } },
});
