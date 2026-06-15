import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  server: {
    // Honor PORT when set (preview/CI harnesses assign one); default stays 5173.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      // 127.0.0.1 explicitly — the server binds AF_INET only, but Node's DNS
      // resolves "localhost" to ::1 first on Windows, so a `localhost` target
      // hits ECONNREFUSED on IPv6 even though IPv4 is listening.
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
