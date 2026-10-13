import type { AppIdentity, AppIdentitySource } from '@bugsee/core';

/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

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
