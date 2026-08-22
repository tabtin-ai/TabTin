/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_PUBLIC_WEB_BASE_URL?: string
  readonly VITE_COLLAB_WS_BASE?: string
  readonly VITE_CENTRIFUGO_WS_URL?: string
  readonly VITE_TABLE_COLLAB_WS_URL?: string
  readonly VITE_TABLE_COLLAB_DISABLED?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  readonly __TABTIN_RUNTIME_CONFIG__?: {
    readonly API_BASE_URL?: string
    readonly PUBLIC_WEB_BASE_URL?: string
    readonly COLLAB_WS_BASE?: string
    readonly CENTRIFUGO_WS_URL?: string
  }
}
