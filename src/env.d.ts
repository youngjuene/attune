/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MANIFEST_URL?: string;
  readonly VITE_AUDIO_LOAD_TIMEOUT_MS?: string;
  readonly VITE_PROGRESS_UPDATE_HZ?: string;
  readonly VITE_SOURCE_RADIUS_M?: string;
  readonly VITE_BUILD_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
