/** Build-time environment variables exposed to the frontend by Vite. */
interface ImportMetaEnv {
  /** Backend API base URL. Defaults to "/api" (same-origin reverse proxy). */
  readonly VITE_OPENNAS_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
