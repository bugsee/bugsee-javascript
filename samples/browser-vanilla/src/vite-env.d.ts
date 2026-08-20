/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly BUGSEE_APP_TOKEN: string;
  readonly BUGSEE_ENDPOINT: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
