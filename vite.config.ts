import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'

const base = process.env.VITE_BASE_PATH || '/'

export default defineConfig({
  base,
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/pwa-192.png', 'icons/pwa-512.png', 'icons/maskable-512.png'],
      manifest: {
        name: 'Local FLAC Player',
        short_name: 'FLAC Player',
        description: 'Local-first FLAC player for a phone music library.',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        theme_color: '#111111',
        background_color: '#111111',
        orientation: 'portrait-primary',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html'
      }
    })
  ]
})
