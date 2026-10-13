import type { AppIdentity, AppIdentitySource } from '@bugsee/core';

/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

/** How a browser page is told its version: it has no process environment at runtime. */
export const BROWSER_APP_VERSION_HINT =
  'Pass `appVersion` (and `appBuild`) to launch(), use the Bugsee Vite or webpack plugin (it defines `__BUGSEE_APP_VERSION__`), set that constant yourself, or add <meta name="bugsee:app-version" content="...">.';

const metaContent = (doc: Document, name: string): string | undefined =>
  doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined;

/** Reads the app version/build a page declares through `<meta name="bugsee:app-version|app-build">`. */
export const metaAppIdentity =
  (doc: Document | undefined): AppIdentitySource =>
  (): AppIdentity | undefined => {
    if (doc === undefined) {
      return undefined;
    }
    return {
      version: metaContent(doc, 'bugsee:app-version'),
      build: metaContent(doc, 'bugsee:app-build'),
    };
  };
