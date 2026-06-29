/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_USE_MOCK?: string
  readonly VITE_APPS_READ_IS_CHEAP?: string
  readonly VITE_API_PROXY?: string
  readonly VITE_GATEWAY_LOGIN_URL?: string
  readonly VITE_GATEWAY_LOGOUT_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
