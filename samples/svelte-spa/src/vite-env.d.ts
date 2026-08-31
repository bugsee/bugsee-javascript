/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUGSEE_APP_TOKEN: string;
  readonly VITE_BUGSEE_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
