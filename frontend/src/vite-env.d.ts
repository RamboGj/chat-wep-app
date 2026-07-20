/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the Go API, *without* the `/api/v1` prefix — that is appended in
   * `lib/api.ts`. Optional; unset means same-origin, which is what the dev
   * proxy serves.
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
