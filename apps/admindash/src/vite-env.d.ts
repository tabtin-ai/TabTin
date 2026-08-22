/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string
  readonly VITE_WS_BASE_URL: string
  readonly VITE_AUTH_EMAIL_LOGIN_ENABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
