import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// The backend sets httpOnly auth cookies, and the refresh cookie is scoped to
// the exact path /api/v1/auth/refresh. Proxying keeps the browser on a single
// origin, so those cookies are sent without any CORS setup on the API.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3080'

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false, // preserve Origin so the WS upgrade check sees it
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
     tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] })
  ],
})
