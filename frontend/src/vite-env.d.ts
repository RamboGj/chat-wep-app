/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the Go API, including the version prefix. Optional — defaults
   * to the same-origin `/api/v1` that the dev proxy serves.
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
