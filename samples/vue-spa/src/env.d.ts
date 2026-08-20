/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_BUGSEE_APP_TOKEN: string;
  readonly VITE_BUGSEE_ENDPOINT: string;
  readonly VITE_BUGSEE_APP_BUILD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
