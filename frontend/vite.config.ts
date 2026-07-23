import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')

  // Proxying keeps the browser on a single origin, so local dev needs no CORS
  // setup on the API at all. Auth itself no longer depends on this — it rides
  // on a bearer token, which crosses origins fine.
  const apiTarget = env.VITE_API_TARGET ?? 'http://localhost:3080'

  return {
    server: {
      proxy: {
        '/api': {
          target: apiTarget,
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
      react(),
      tailwindcss(),
      babel({ presets: [reactCompilerPreset()] })
    ],
  }
})
